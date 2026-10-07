from fastapi import APIRouter
router = APIRouter()

import io
import os
import base64
import json
import logging
import traceback
import numpy as np
import matplotlib
matplotlib.use('Agg')
from fastapi import APIRouter, HTTPException

from pydantic import BaseModel
from typing import List, Dict, Any, Optional
from pycalphad import Database, variables as v, calculate, equilibrium
from pycalphad.core.utils import instantiate_models
import xarray as xr
from collections import OrderedDict
from itertools import chain
import time
import seaborn as sns
import asyncio
import sys
import contextlib
import multiprocessing
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool

# Use spawn context for ProcessPoolExecutor to avoid fork-related segfaults with C extensions
mp_context = multiprocessing.get_context('spawn')
executor = None

def get_executor():
    global executor
    if executor is None:
        executor = ProcessPoolExecutor(max_workers=2, mp_context=mp_context)
    return executor

def reset_executor():
    global executor
    if executor is not None:
        executor.shutdown(wait=False)
        executor = None

# Context manager to capture stdout (print) to the logging system
@contextlib.contextmanager
def capture_stdout_to_log(logger_name='pduq_analysis'):
    original_stdout = sys.stdout
    class Tee:
        def __init__(self, name):
            self.logger = logging.getLogger(name)
            self.stdout = original_stdout
            self._in_write = False
        def write(self, data):
            if data.strip() and not self._in_write:
                self._in_write = True
                try:
                    # Use the logger to capture the output
                    self.logger.info(data.strip())
                finally:
                    self._in_write = False
            # Still write to the original stdout (which goes to backend.log)
            self.stdout.write(data)
        def flush(self):
            self.stdout.flush()
    
    sys.stdout = Tee(logger_name)
    try:
        yield
    finally:
        sys.stdout = original_stdout

from scipy.stats import gaussian_kde
import pickle
import symengine

# Dask Imports
try:
    from dask.distributed import Client, LocalCluster
    HAS_DASK = True
except ImportError:
    HAS_DASK = False

# Configure logging
# Attach to root logger to capture ALL logs (including pduq_core and pycalphad)
root_logger = logging.getLogger()
root_logger.setLevel(logging.INFO)

# Console Handler - Clean output
c_handler = logging.StreamHandler(sys.stdout)
c_handler.setLevel(logging.INFO)

# File Handler - Detailed records
# Use mode='a' and encoding='utf-8' for better compatibility
f_handler = logging.FileHandler('pduq.log', mode='a', encoding='utf-8')
f_handler.setLevel(logging.INFO)

formatter = logging.Formatter('%(levelname)s:%(name)s:%(message)s')
c_handler.setFormatter(formatter)
f_handler.setFormatter(formatter)

class ConsoleFilter(logging.Filter):
    def filter(self, record):
        msg = record.getMessage()
        # 1. Filter out polling logs (uvicorn access logs)
        if "/analysis/log" in msg:
            return False
        if "/analysis/inspect_tdb" in msg:
            return False
        if "/analysis/inspect_trace" in msg:
            return False
        
        # 2. Filter out internal details from console (keep for file)
        internal_loggers = ["distributed", "dask", "pycalphad", "pduq_core", "bokeh", "tornado"]
        if any(name in record.name for name in internal_loggers):
            return False
            
        # 3. Filter out specific noisy messages from engine_analysis
        noisy_prefixes = [
            "Received calculation request:",
            "Starting Phase Diagram Calculation",
            "PDUQ: All database symbols:",
            "PDUQ: Found",
            "Parameters:",
            "Loading TDB",
            "Database loaded",
            "Loading trace",
            "Raw trace shape",
            "Processed params shape",
            "Attempting to load",
            "Setting up Dask",
            "Dask client:",
            "Config:",
            "Conditions:",
            "Symbols to fit",
            "Shape mismatch",
            "Calling eq_calc_samples",
            "eq_calc_samples finished",
            "Unique phases found",
            "Plotting superimposed diagram",
            "Serial execution finished",
            "Plotting finished",
            "Starting calculation:",
            "<xarray.Dataset>",
            "Dimensions:",
            "Coordinates:",
            "Data variables:",
            "Attributes:",
            "sample",
            "vertex",
            "internal_dof",
            "[", # For the chunk logs like [2, 22]
            "PDUQ:"
        ]
        
        # Check if any prefix matches (case-insensitive and stripped)
        msg_clean = msg.strip()
        if any(msg_clean.startswith(prefix) for prefix in noisy_prefixes):
            return False
            
        return True

# c_handler.addFilter(ConsoleFilter())

# Remove existing handlers to avoid duplicates
root_logger.handlers = []
root_logger.addHandler(c_handler)
root_logger.addHandler(f_handler)

# Silence uvicorn access logs and redirect them to our handlers
for logger_name in ["uvicorn", "uvicorn.access", "uvicorn.error", "fastapi"]:
    l = logging.getLogger(logger_name)
    l.handlers = []
    l.propagate = True

# Clear the log file at startup (only in main process)
if multiprocessing.current_process().name == 'MainProcess':
    with open('pduq.log', 'w', encoding='utf-8') as f:
        f.write("ThermoAI Analysis Log Initialized\n")

logger = logging.getLogger("pduq_analysis")
logger.info("Logging system initialized.")

# --- PDUQ Core Functions (Imported) ---
from pduq_core import (
    database_symbols_to_fit, eq_calc_samples, invariant_samples,
    plot_dist, plot_property, plot_phase_property, plot_phasefracline, plot_phasecompline, plot_superimposed, plot_trace,
    plot_contour, plot_binary, cluster_invariant_points
)

# --- API Endpoints ---

@router.get("/analysis/log")
async def get_log():
    try:
        log_file = 'pduq.log'
        if os.path.exists(log_file):
            # Use a more robust way to read the log that handles concurrent writes
            with open(log_file, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
            return {"status": "success", "log": content}
        else:
            return {"status": "success", "log": "No log file found."}
    except Exception as e:
        return {"status": "error", "message": str(e)}

# Global Dask Client
dask_client = None
_current_dask_config = None

try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

def get_dask_client(n_workers=8, threads_per_worker=1):
    global dask_client, _current_dask_config
    if not HAS_DASK: return None
    
    # Intelligently limit workers based on available memory to prevent OOM
    if HAS_PSUTIL:
        try:
            mem = psutil.virtual_memory()
            # Assume each pycalphad worker needs ~300MB
            max_workers_by_mem = max(1, int(mem.available / (300 * 1024**2)))
            if n_workers > max_workers_by_mem:
                logging.warning(f"Limiting Dask workers from {n_workers} to {max_workers_by_mem} due to memory constraints ({mem.available / 1024**2:.0f}MB available).")
                n_workers = max_workers_by_mem
        except Exception as e:
            logging.warning(f"Could not determine memory limits: {e}")

    new_config = (n_workers, threads_per_worker)
    if dask_client is not None and _current_dask_config != new_config:
        try:
            dask_client.close()
            dask_client.cluster.close()
        except: pass
        dask_client = None
    if dask_client is None:
        if n_workers <= 1: return None
        try:
            # Disable Dask to prevent multiprocessing/fork segfaults with pycalphad
            return None
            
            # User script uses processes (LocalCluster default), so we enable them even on Windows
            # bridge.py has the necessary __main__ guard.
            cluster = LocalCluster(n_workers=n_workers, threads_per_worker=threads_per_worker, processes=True, dashboard_address=None, memory_limit=0)
            dask_client = Client(cluster)
            _current_dask_config = new_config
        except Exception as e:
            logger.error(f"Failed to start Dask client: {e}")
            return None
    return dask_client

def load_trace_file(trace_path: str = None, trace_content: str = None) -> np.ndarray:
    if trace_content:
        try:
            logging.info(f"Attempting to load trace from content (len={len(trace_content)})")
            if trace_content.startswith('data:'):
                _, encoded = trace_content.split(',', 1)
                decoded = base64.b64decode(encoded)
                return np.load(io.BytesIO(decoded))
            
            # Try loading as CSV/Text
            try:
                trace = np.loadtxt(io.StringIO(trace_content), delimiter=',')
                if trace.ndim == 1: trace = trace.reshape(1, -1)
                return trace
            except Exception:
                # Try skipping header
                trace = np.loadtxt(io.StringIO(trace_content), delimiter=',', skiprows=1)
                if trace.ndim == 1: trace = trace.reshape(1, -1)
                return trace
                
        except Exception as e:
            logging.warning(f"Failed to parse trace content: {e}. Falling back to path if available.")
            # Fallthrough to path loading
    
    if trace_path:
        logging.info(f"Attempting to load trace from path: {trace_path}")
        try:
            # Handle relative paths / leading slashes
            if not os.path.exists(trace_path) and trace_path.startswith('/'): 
                trace_path = trace_path[1:]
            
            if not os.path.exists(trace_path):
                # Try looking in current directory if path is just a filename
                if os.path.exists(os.path.basename(trace_path)):
                    trace_path = os.path.basename(trace_path)
                else:
                    raise FileNotFoundError(f"File not found: {trace_path} (Abs: {os.path.abspath(trace_path)})")

            if trace_path.endswith('.npy'):
                return np.load(trace_path)
            else:
                return np.loadtxt(trace_path, delimiter=',')
        except Exception as e:
            raise ValueError(f"Failed to load trace file from path {trace_path}: {e}")
    
    raise ValueError("No valid trace data provided (content parsing failed and no valid path found)")

class AnalysisRequest(BaseModel):
    tdb_content: Optional[str] = None
    trace_content: Optional[str] = None
    tdb_path: Optional[str] = None
    trace_path: Optional[str] = None
    calculation_type: str
    parameters: Dict[str, Any]
    trace_slice_mode: Optional[str] = "last"
    trace_slice_val: Optional[int] = 1
    dask_n_workers: Optional[int] = 8
    dask_threads_per_worker: Optional[int] = 1

class InspectTdbRequest(BaseModel):
    tdb_path: Optional[str] = None
    tdb_content: Optional[str] = None

@router.post("/analysis/inspect_tdb")
async def inspect_tdb_endpoint(req: InspectTdbRequest):
    try:
        content = req.tdb_content
        if not content and req.tdb_path:
            if os.path.exists(req.tdb_path):
                with open(req.tdb_path, 'r') as f: content = f.read()
            elif req.tdb_path.startswith('/') and os.path.exists(req.tdb_path[1:]):
                 with open(req.tdb_path[1:], 'r') as f: content = f.read()
        if not content: return {"status": "error", "message": "No TDB content provided"}
        content = content.replace('\r\n', '\n').replace('\r', '\n').replace('\xa0', ' ')
        dbf = Database(io.StringIO(content))
        components = sorted([str(c).upper() for c in dbf.elements if str(c).upper() not in ['VA', '/-']])
        phases = sorted(list(dbf.phases.keys()))
        return {"status": "success", "components": components, "phases": phases}
    except Exception as e:
        return {"status": "error", "message": str(e)}

def process_trace_slice(params: np.ndarray, mode: str, val: int) -> np.ndarray:
    if params.ndim == 2:
        if mode == "last": return params
        elif mode == "last_n": return params[-val:, :]
        elif mode == "specific": return params[val:val+1, :] if 0 <= val < params.shape[0] else params[-1:, :]
        else: return params
    elif params.ndim == 3:
        if mode == "last": return params[:, -1, :]
        elif mode == "last_n":
            sliced = params[:, -val:, :]
            return sliced.reshape(-1, sliced.shape[-1])
        elif mode == "specific":
            if -params.shape[1] <= val < params.shape[1]:
                return params[:, val, :]
            else:
                return params[:, -1, :]
        elif mode == "all": return params.reshape(-1, params.shape[-1])
        else: return params[:, -1, :]
    else: return params

@router.post("/analysis/inspect_trace")
async def inspect_trace(req: AnalysisRequest):
    try:
        params = load_trace_file(req.trace_path, req.trace_content)
        return {"status": "success", "shape": params.shape, "ndim": params.ndim, "message": f"Trace loaded with shape {params.shape}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

def extract_points_from_dataset(dataset, component):
    """
    Extract (X, T) points from an ESPEI-formatted dataset.
    """
    points = []
    if not isinstance(dataset, dict):
        return points
    
    # Case-insensitive component matching
    target_comp = component.upper()
    
    output = dataset.get('output', '').upper()
    conditions = dataset.get('conditions', {})
    values = dataset.get('values', [])
    top_components = [c.upper() for c in dataset.get('components', [])]
    
    if output == 'ZPF':
        T_cond = conditions.get('T')
        if T_cond is None:
            return points
            
        if not isinstance(T_cond, list):
            T_vals = [T_cond]
        else:
            T_vals = T_cond
            
        # Handle broadcast_conditions
        broadcast = dataset.get('broadcast_conditions', False)
        
        for i, row in enumerate(values):
            # Determine T for this row
            if broadcast or len(T_vals) == 1:
                T = T_vals[0]
            elif i < len(T_vals):
                T = T_vals[i]
            else:
                break
                
            if isinstance(T, list): T = T[0]
            
            if not isinstance(row, list): continue
            
            for tie_line in row:
                # tie_line is [phase, components, compositions]
                if isinstance(tie_line, list) and len(tie_line) >= 3:
                    # If components is null, use top-level components
                    comps = tie_line[1]
                    if comps is None:
                        comps = top_components
                    else:
                        comps = [c.upper() for c in comps]
                        
                    vals = tie_line[2]
                    
                    # 1. Try direct match
                    if target_comp in comps:
                        idx = comps.index(target_comp)
                        if idx < len(vals) and vals[idx] is not None:
                            try:
                                points.append({
                                    "x": float(vals[idx]), 
                                    "T": float(T), 
                                    "label": f"ZPF ({tie_line[0]})"
                                })
                            except (ValueError, TypeError):
                                continue
                    # 2. If binary system, try calculating from the other component
                    elif target_comp in top_components:
                        real_comps = [c for c in top_components if c != 'VA']
                        if len(real_comps) == 2:
                            other_comp = [c for c in real_comps if c != target_comp][0]
                            if other_comp in comps:
                                idx = comps.index(other_comp)
                                if idx < len(vals) and vals[idx] is not None:
                                    try:
                                        points.append({
                                            "x": 1.0 - float(vals[idx]), 
                                            "T": float(T), 
                                            "label": f"ZPF ({tie_line[0]})"
                                        })
                                    except (ValueError, TypeError):
                                        continue
    
    # Handle simple format with case-insensitivity
    elif any(k.lower() == 'x' for k in dataset) and any(k.lower() == 't' for k in dataset):
        x_key = next((k for k in dataset if k.lower() == 'x'), None)
        t_key = next((k for k in dataset if k.lower() == 't'), None)
        if x_key and t_key:
            try:
                points.append({
                    "x": float(dataset[x_key]), 
                    "T": float(dataset[t_key]), 
                    "label": dataset.get('label', 'Exp')
                })
            except (ValueError, TypeError):
                pass
            
    return points

def _calculate_analysis_sync(req: AnalysisRequest):
    # Ensure log file exists and is clean for a new run
    # We use a separator to make it clear in the log
    with open('pduq.log', 'a', encoding='utf-8') as f:
        f.write(f"\n{'='*40}\n")
        f.write(f"NEW CALCULATION: {req.calculation_type}\n")
        f.write(f"TIME: {time.ctime()}\n")
        f.write(f"{'='*40}\n\n")

    with capture_stdout_to_log('pduq_analysis'):
        try:
            logging.info(f"Received calculation request: {req.calculation_type}")
            logging.info(f"Parameters: {req.parameters}")

            # 1. Load Database
            try:
                if req.tdb_content:
                    logging.info("Loading TDB from content")
                    content = req.tdb_content
                    if content.startswith('data:'):
                        _, encoded = content.split(',', 1)
                        content = base64.b64decode(encoded).decode('utf-8')
                    if content.startswith('\ufeff'): content = content[1:]
                    content = content.replace('\r\n', '\n').replace('\r', '\n').replace('\xa0', ' ')
                    dbf = Database(io.StringIO(content))
                elif req.tdb_path:
                    logging.info(f"Loading TDB from path: {req.tdb_path}")
                    tdb_file = req.tdb_path
                    if not os.path.exists(tdb_file) and tdb_file.startswith('/'): tdb_file = tdb_file[1:]
                    with open(tdb_file, 'r') as f: tdb_content = f.read()
                    tdb_content = tdb_content.replace('\r\n', '\n').replace('\r', '\n').replace('\xa0', ' ')
                    dbf = Database(io.StringIO(tdb_content))
                else:
                    raise ValueError("No TDB data provided")
                logging.info(f"Database loaded. Elements: {dbf.elements}, Phases: {list(dbf.phases.keys())}")
            except Exception as e:
                logging.error(f"Error loading database: {e}")
                raise ValueError(f"Failed to load database: {e}")
            
            # 2. Load Trace
            try:
                logging.info(f"Loading trace from {req.trace_path or 'content'}")
                raw_params = load_trace_file(req.trace_path, req.trace_content)
                logging.info(f"Raw trace shape: {raw_params.shape}")
                
                params = process_trace_slice(raw_params, req.trace_slice_mode, req.trace_slice_val)
                if params.ndim != 2: params = params.reshape(-1, params.shape[-1])
                logging.info(f"Processed params shape: {params.shape}")
            except Exception as e:
                logging.error(f"Error loading trace: {e}")
                raise ValueError(f"Failed to load trace: {e}")

            # 3. Setup Dask
            try:
                logging.info(f"Setting up Dask client with {req.dask_n_workers} workers")
                client = get_dask_client(n_workers=req.dask_n_workers, threads_per_worker=req.dask_threads_per_worker)
                logging.info(f"Dask client: {client}")
            except Exception as e:
                logging.error(f"Error setting up Dask: {e}")
                raise ValueError(f"Failed to setup Dask: {e}")

            calc_type = req.calculation_type
            config = req.parameters
            sample_info = ""
            
            if calc_type == "single_point":
                comps = config.get('components', list(dbf.elements))
                phases = config.get('phases', list(dbf.phases.keys()))
                temp = float(config.get('T', 1000))
                pres = float(config.get('P', 101325))
                conds = {v.T: temp, v.P: pres}
                x_comp = None
                for k, val in config.get('composition', {}).items():
                    comp_name = k[2:] if k.startswith('X_') else k
                    conds[v.X(comp_name)] = float(val)
                    if x_comp is None:
                        x_comp = comp_name
                
                n_samples = params.shape[0]
                params_subset = params
                eq = eq_calc_samples(dbf, conds, params_subset, comps=comps, phases=phases, client=client)
                
                # Find active phase regions
                phase_data = eq.get('Phase').values
                phase_data = phase_data.reshape(phase_data.shape[0], -1)
                active_regions = {}
                for i in range(phase_data.shape[0]):
                    phases_in_sample = tuple(sorted(set(p for p in phase_data[i] if p and str(p) != 'None' and str(p) != '')))
                    if phases_in_sample in active_regions:
                        active_regions[phases_in_sample] += 1
                    else:
                        active_regions[phases_in_sample] = 1
                
                target_phase = config.get('target_phase')
                target_phasereg = None
                max_count = -1
                
                # Format active regions for output
                active_regions_info = "\n" + "="*40 + "\n"
                active_regions_info += f"{'Phase Region':<30} | {'Probability':<10}\n"
                active_regions_info += "-"*40 + "\n"
                
                for region, count in sorted(active_regions.items(), key=lambda item: item[1], reverse=True):
                    prob = count / phase_data.shape[0]
                    active_regions_info += f"{str(list(region)):<30} | {prob:.2%}\n"
                    
                    if target_phase and target_phase in region and count > max_count:
                        target_phasereg = list(region)
                        max_count = count
                
                if target_phasereg is None and active_regions:
                    target_phasereg = list(max(active_regions, key=active_regions.get))
                    if not target_phase:
                        target_phase = target_phasereg[0]
                
                if target_phasereg is None:
                    raise RuntimeError("No active phase regions found.")
                
                if target_phase not in target_phasereg:
                    active_regions_info += f"\nWarning: Target phase '{target_phase}' not found in any active region. Falling back to {target_phasereg[0]}.\n"
                    target_phase = target_phasereg[0]
                
                if not x_comp and len(comps) > 1: 
                    x_comp = comps[1] if comps[0] != 'VA' else comps[0]
                
                coordD = {k.name if hasattr(k, 'name') else str(k): val for k, val in conds.items()}
                coordD['component'] = x_comp
                
                from PIL import Image
                
                # Plot NP
                fig1, _ = plot_dist(eq, coordD, target_phasereg, target_phase, typ='NP', figsize=(5, 3))
                fig1.suptitle(f'Fraction of {target_phase} at {temp}K')
                buf1 = io.BytesIO()
                fig1.savefig(buf1, format='png', bbox_inches='tight')
                buf1.seek(0)
                img1_str = base64.b64encode(buf1.read()).decode('utf-8')
                
                # Plot X
                fig2, _ = plot_dist(eq, coordD, target_phasereg, target_phase, typ='X', figsize=(5, 3))
                fig2.suptitle(f'{x_comp} Content in {target_phase}')
                buf2 = io.BytesIO()
                fig2.savefig(buf2, format='png', bbox_inches='tight')
                buf2.seek(0)
                img2_str = base64.b64encode(buf2.read()).decode('utf-8')
                
                sample_info = f"Selected Region: {target_phasereg}, Target Phase: {target_phase}"
                
                return {
                    "status": "success",
                    "images": [img1_str, img2_str],
                    "message": f"Calculation {calc_type} completed successfully. {sample_info}",
                    "terminal_output": f"Successfully completed {calc_type}.\n{active_regions_info}\n{sample_info}\nOutput images generated."
                }
                
            elif calc_type == "phase_diagram":
                logging.info("Starting Phase Diagram Calculation")
                comps = config.get('components', list(dbf.elements))
                
                # Support uq_phases for consistency with other UQ analyses
                uq_phases = config.get('uq_phases')
                if uq_phases and isinstance(uq_phases, list) and len(uq_phases) > 0:
                    phases = uq_phases
                else:
                    phases = config.get('phases', list(dbf.phases.keys()))
                
                n_samples = params.shape[0]
                params_subset = params
                
                x_comp = config.get('x_component')
                if not x_comp or x_comp not in dbf.elements:
                    non_va = [e for e in dbf.elements if e != 'VA']
                    x_comp = non_va[0] if non_va else list(dbf.elements)[0]
                
                t_min = float(config.get('t_min', 500))
                t_max = float(config.get('t_max', 1000))
                t_step = float(config.get('t_step', 20))
                
                logging.info(f"Config: X_comp={x_comp}, T=({t_min}, {t_max}, {t_step})")
                
                temps = (t_min, t_max, t_step)
                x_vals = (0, 1, 0.05) # Coarser step (0.05) for speed, matching user script
                
                conds = {v.P: 101325, v.T: temps, v.X(x_comp): x_vals}
                logging.info(f"Conditions: {conds}")
                
                symbols = [s for s in dbf.symbols if s.startswith('V')]
                logging.info(f"Symbols to fit ({len(symbols)}): {symbols}")
                
                if params_subset.shape[1] != len(symbols):
                    logging.warning(f"Shape mismatch! Params columns: {params_subset.shape[1]}, Symbols: {len(symbols)}")
                
                try:
                    logging.info("Calling eq_calc_samples...")
                    eq = eq_calc_samples(dbf, conds, params_subset, comps=comps, phases=phases, client=client, symbols_to_fit=symbols)
                    if eq is not None:
                      logging.info(f"eq_calc_samples finished. Result shape: {eq.dims}")
                    else:
                        logging.error("eq_calc_samples returned None")
                except Exception as dask_err:
                    logging.error(f"Dask calculation failed: {dask_err}")
                    logging.error(traceback.format_exc())
                    logging.info("Retrying with serial execution...")
                    try:
                        eq = eq_calc_samples(dbf, conds, params_subset, comps=comps, phases=phases, client=None, symbols_to_fit=symbols)
                        if eq is not None:
                            logging.info(f"Serial execution finished. Result shape: {eq.dims}")
                        else:
                            logging.error("Serial execution returned None")
                    except Exception as serial_err:
                        logging.error(f"Serial execution failed: {serial_err}")
                        raise RuntimeError(f"Both Dask and Serial execution failed.\nDask Error: {dask_err}\nSerial Error: {serial_err}")
                
                if eq is None: 
                    raise RuntimeError("Equilibrium calculation returned None.")

                try:
                    phaseL = list(np.unique(eq.get('Phase').values))
                    if '' in phaseL: phaseL.remove('')
                    nph = len(phaseL)
                    logging.info(f"Unique phases found: {phaseL}")
                    
                    colorL = sns.color_palette("cubehelix", nph+2)
                    cdict = {phaseL[ii]: colorL[ii] for ii in range(nph)}
                    
                    logging.info("Plotting superimposed diagram...")
                    
                    # Extract plotting options
                    xlim_min = config.get('xlim_min')
                    xlim_max = config.get('xlim_max')
                    xlims = [-0.01, 1.01]
                    if xlim_min is not None and xlim_max is not None and xlim_min != '' and xlim_max != '':
                        try: xlims = [float(xlim_min), float(xlim_max)]
                        except: pass
                        
                    fig = plot_superimposed(eq, x_comp, alpha=0.15, xlims=xlims, cdict=cdict, figsize=(8, 6), markersize=1.0)
                    logging.info("Plotting finished.")
                    
                except Exception as plot_err:
                    logging.error(f"Plotting failed: {plot_err}")
                    logging.error(traceback.format_exc())
                    raise RuntimeError(f"Plotting failed: {plot_err}")

                sample_info = f"Samples: {n_samples}, Symbols: {len(symbols)}"
                
            elif calc_type == "phase_fraction":
                comps = config.get('components', list(dbf.elements))
                
                # Support uq_phases for consistency with property UQ
                uq_phases = config.get('uq_phases')
                if uq_phases and isinstance(uq_phases, list) and len(uq_phases) > 0:
                    phases = uq_phases
                else:
                    phases = config.get('phases', list(dbf.phases.keys()))
                
                params_subset = params
                vary = config.get('vary', 'T')
                fixed_val = float(config.get('fixed_val', 0.5))
                x_comp = config.get('x_component')
                if x_comp not in dbf.elements:
                    non_va = [e for e in dbf.elements if e != 'VA']
                    x_comp = non_va[0] if non_va else list(dbf.elements)[0]
                
                if vary == 'T':
                    t_min = float(config.get('min', 500))
                    t_max = float(config.get('max', 1500))
                    steps_val = float(config.get('steps', 20))
                    if 0 < steps_val < 2:
                        steps = int(abs(t_max - t_min) / steps_val) + 1
                    else:
                        steps = int(steps_val)
                    steps = max(2, steps)
                    range_vals = np.linspace(t_min, t_max, steps)
                    conds = {v.P: 101325, v.T: range_vals, v.X(x_comp): fixed_val}
                    xlabel = 'T (K)'
                    coordD = {str(v.X(x_comp)): fixed_val}
                else:
                    t_val = fixed_val
                    x_min = float(config.get('min', 0.01))
                    x_max = float(config.get('max', 0.99))
                    steps_val = float(config.get('steps', 20))
                    if 0 < steps_val < 2:
                        steps = int(abs(x_max - x_min) / steps_val) + 1
                    else:
                        steps = int(steps_val)
                    steps = max(2, steps)
                    range_vals = np.linspace(x_min, x_max, steps)
                    conds = {v.P: 101325, v.T: t_val, v.X(x_comp): range_vals}
                    xlabel = f'x_{{{x_comp}}}'
                    coordD = {str(v.T): t_val}
                eq = eq_calc_samples(dbf, conds, params_subset, comps=comps, phases=phases, client=client)
                
                # Extract plotting options
                xlabel_cfg = config.get('xlabel', xlabel)
                ylabel_cfg = config.get('ylabel')
                yscale_cfg = config.get('yscale')
                xlim_min = config.get('xlim_min')
                xlim_max = config.get('xlim_max')
                xlim = None
                if xlim_min is not None and xlim_max is not None and str(xlim_min).strip() and str(xlim_max).strip():
                    xlim = [float(xlim_min), float(xlim_max)]

                # Plot phase fraction
                fig1 = plot_phasefracline(eq, coordD, xlabel=xlabel_cfg, ylabel=ylabel_cfg, xlim=xlim, yscale=yscale_cfg)
                buf1 = io.BytesIO()
                fig1.savefig(buf1, format='png', bbox_inches='tight')
                buf1.seek(0)
                img1_str = base64.b64encode(buf1.read()).decode('utf-8')
                
                # Plot phase composition
                fig2 = plot_phasecompline(eq, coordD, comp=x_comp, xlabel=xlabel_cfg, ylabel=ylabel_cfg, xlim=xlim, yscale=yscale_cfg)
                buf2 = io.BytesIO()
                fig2.savefig(buf2, format='png', bbox_inches='tight')
                buf2.seek(0)
                img2_str = base64.b64encode(buf2.read()).decode('utf-8')
                
                return {
                    "status": "success",
                    "images": [img1_str, img2_str],
                    "message": f"Calculation {calc_type} completed successfully. {sample_info}",
                    "terminal_output": f"Successfully completed {calc_type}.\n{sample_info}\nOutput images generated."
                }

            elif calc_type == "invariant":
                comp = config.get('component')
                x_guess = float(config.get('x_guess', 0.5))
                t_low = float(config.get('t_low', 500))
                t_high = float(config.get('t_high', 1000))
                n_clusters = config.get('n_clusters')
                try:
                    if n_clusters and str(n_clusters).strip():
                        n_clusters = int(n_clusters)
                    else:
                        n_clusters = None
                except:
                    n_clusters = None
                bw = config.get('bw', 0.5)
                try:
                    bw = float(bw)
                except:
                    # Keep as string if it's 'scott' or 'silverman'
                    pass
                
                prob_levels = config.get('prob_levels')
                if prob_levels and isinstance(prob_levels, list):
                    levels = [float(item.get('prob', 0.6)) for item in prob_levels]
                    colors = [item.get('color', '#92c5de') for item in prob_levels]
                else:
                    prob_range_str = config.get('prob_range', '0.6, 0.8, 0.9')
                    prob_colors_str = config.get('prob_colors', '#92c5de, #0571b0, #2166ac')
                    try:
                        levels = [float(x.strip()) for x in prob_range_str.split(',')]
                    except:
                        levels = [0.6, 0.8, 0.9]
                    
                    try:
                        colors = [x.strip() for x in prob_colors_str.split(',')]
                    except:
                        colors = sns.color_palette("Blues", len(levels))
                
                raw_exp_data = config.get('exp_data', [])
                if not isinstance(raw_exp_data, list):
                    raw_exp_data = []
                
                datasets_path = config.get('datasets_path')
                if datasets_path and os.path.isdir(datasets_path):
                    logging.info(f"Scanning datasets_path: {datasets_path}")
                    for root, dirs, files in os.walk(datasets_path):
                        for f in files:
                            if f.lower().endswith('.json'):
                                fpath = os.path.join(root, f)
                                try:
                                    with open(fpath, 'r') as jf:
                                        dataset = json.load(jf)
                                        if isinstance(dataset, list):
                                            raw_exp_data.extend(dataset)
                                        else:
                                            raw_exp_data.append(dataset)
                                except Exception as e:
                                    logging.error(f"Error reading dataset {fpath}: {e}")
                                    continue
                
                exp_data = []
                total_extracted = 0
                logging.info(f"Processing {len(raw_exp_data)} experimental data items for component {comp}")
                for item in raw_exp_data:
                    # If item is already a list (from a file containing multiple points)
                    extracted = []
                    if isinstance(item, list):
                        for subitem in item:
                            extracted.extend(extract_points_from_dataset(subitem, comp))
                    else:
                        extracted.extend(extract_points_from_dataset(item, comp))
                    
                    total_extracted += len(extracted)
                    # Filter points to be within a reasonable range of the invariant point
                    # We use the search range [t_low, t_high] and x_guess plus some margin
                    # We use a wider margin for composition (0.5) to catch relevant solvus data
                    for p in extracted:
                        t_match = t_low - 200 <= p['T'] <= t_high + 200
                        x_match = abs(p['x'] - x_guess) <= 0.5
                        if t_match and x_match:
                            exp_data.append(p)
                        else:
                            logging.debug(f"Point {p} filtered out. T match: {t_match}, X match: {x_match}")
                
                exp_count = len(exp_data)
                logging.info(f"Total extracted: {total_extracted}, Filtered: {exp_count}")
                if not exp_data:
                    exp_data = None
                
                n_samples = params.shape[0]
                if n_samples < 100:
                    logging.warning(f"Low sample size ({n_samples}) for invariant calculation. Consider increasing MCMC iterations for better results.")
                
                params_subset = params
                Tv, phv, bndv = invariant_samples(dbf, params_subset, x_guess, 101325, t_low, t_high, comp, client=client)
                points = np.zeros((len(Tv), 2))
                points[:, 0] = bndv[:, 1]
                points[:, 1] = Tv
                
                # Perform clustering
                clusters = cluster_invariant_points(points, n_clusters=n_clusters)
                
                fig = plot_contour(points, c=colors, levels=levels, plot_points=True, clusters=clusters, exp_data=exp_data, bw=bw)
                
                ax = fig.axes[0]
                ax.set_xlabel(r'$X_{%s}$' % comp, fontsize="large")
                ax.set_ylabel('T (K)', fontsize="large")
                
                cluster_info = []
                for cid in np.unique(clusters):
                    cluster_points = points[clusters == cid]
                    cluster_info.append({
                        "id": int(cid),
                        "count": int(cluster_points.shape[0]),
                        "mean_x": float(np.mean(cluster_points[:, 0])),
                        "mean_T": float(np.mean(cluster_points[:, 1]))
                    })
                
                sample_info = f"Clusters found: {len(cluster_info)}. " + ", ".join([f"C{c['id']}: {c['count']} pts" for c in cluster_info])
                if total_extracted > 0:
                    sample_info += f"\nExperimental points: {total_extracted} found in dataset, {exp_count} overlaid on plot (near X={x_guess:.3f}, T={t_low}-{t_high}K)."
                else:
                    sample_info += "\nNo experimental points found in dataset."
                
            elif calc_type == "property":
                prop = config.get('property', 'GM')
                if prop == 'NP':
                    prop = 'GM' 
                comps = config.get('components', list(dbf.elements))
                
                # UQ involves system-level equilibrium properties, using all given valid phases
                uq_phases = config.get('uq_phases')
                if uq_phases and isinstance(uq_phases, list) and len(uq_phases) > 0:
                    phaseL = uq_phases
                else:
                    phaseL = config.get('phases', list(dbf.phases.keys()))
                
                n_samples = params.shape[0]
                params_subset = params
                vary = config.get('vary', 'T')
                
                yscale = config.get('yscale')
                try: yscale = float(yscale) if yscale != '' else None
                except: yscale = None
                
                ylabel = config.get('ylabel')
                if not ylabel or ylabel == '':
                    if prop == 'GM': ylabel = 'System Molar Gibbs Energy\n(J/mol)'
                    elif prop == 'HM_MIX': ylabel = 'System Molar Enthalpy\n(J/mol)'
                    elif prop == 'ACR': ylabel = 'Activity'
                    else: ylabel = prop
                
                xlabel = config.get('xlabel')
                xlim_min = config.get('xlim_min')
                xlim_max = config.get('xlim_max')
                xlim = None
                if xlim_min is not None and xlim_max is not None and xlim_min != '' and xlim_max != '':
                    try: xlim = [float(xlim_min), float(xlim_max)]
                    except: xlim = None

                raw_exp_data = config.get('exp_data', [])
                if not isinstance(raw_exp_data, list):
                    raw_exp_data = []
                
                datasets_path = config.get('datasets_path')
                if datasets_path and os.path.isdir(datasets_path):
                    logging.info(f"Scanning datasets_path for property: {datasets_path}")
                    for root, dirs, files in os.walk(datasets_path):
                        for f in files:
                            if f.lower().endswith('.json'):
                                fpath = os.path.join(root, f)
                                try:
                                    with open(fpath, 'r') as jf:
                                        dataset = json.load(jf)
                                        if isinstance(dataset, list):
                                            raw_exp_data.extend(dataset)
                                        else:
                                            raw_exp_data.append(dataset)
                                except Exception as e:
                                    logging.warning(f"Failed to load dataset {fpath}: {e}")

                sample_info = f"Property: {prop}, Phases: {', '.join(phaseL)}, Samples: {n_samples}"
                
                try:
                    x_comp = config.get('x_component')
                    if not x_comp or x_comp not in dbf.elements:
                        non_va = [e for e in dbf.elements if e != 'VA']
                        x_comp = non_va[0] if non_va else list(dbf.elements)[0]
                        
                    # Build accurate grid constraints (conds)
                    if vary == 'T':
                        x_val = float(config.get('uq_X_fixed', config.get('fixed_val', 0.5)))
                        t_min = float(config.get('uq_T_min', config.get('min', 300)))
                        t_max = float(config.get('uq_T_max', config.get('max', 1500)))
                        steps_val = float(config.get('steps', 50))
                        steps = int(abs(t_max - t_min) / steps_val) + 1 if 0 < steps_val < 2 else int(steps_val)
                        steps = max(2, steps)
                        T_vals = np.linspace(t_min, t_max, steps)
                        
                        conds = {v.P: 101325, v.T: T_vals, v.X(x_comp): x_val}
                        coordD = {str(v.X(x_comp)): x_val}
                        if not xlabel: xlabel = 'T (K)'
                    else:
                        temp = float(config.get('uq_T_fixed', config.get('fixed_val', 1000)))
                        x_min = float(config.get('uq_X_min', config.get('min', 0.01)))
                        x_max = float(config.get('uq_X_max', config.get('max', 0.99)))
                        steps_val = float(config.get('steps', 50))
                        steps = int(abs(x_max - x_min) / steps_val) + 1 if 0 < steps_val < 2 else int(steps_val)
                        steps = max(2, steps)
                        X_vals = np.linspace(x_min, x_max, steps)
                        
                        conds = {v.P: 101325, v.T: temp, v.X(x_comp): X_vals}
                        coordD = {str(v.T): temp}
                        if not xlabel: xlabel = r'$X_{%s}$' % x_comp

                    symbols = [s for s in dbf.symbols if s.startswith('V')]
                    logging.info("Calling eq_calc_samples for Property UQ...")
                    
                    # Property name and unit
                    if prop == 'GM':
                        prop_name = "Gibbs Energy"
                    elif prop == 'HM_MIX':
                        prop_name = "Mixing Enthalpy"
                    elif prop == 'ACR':
                        prop_name = "Activity"
                    else:
                        prop_name = prop
                    
                    unit = "J/mol" if prop != 'ACR' else ""
                    
                    # If yscale is 1e-3, change unit to kJ/mol
                    yscale = float(config.get('yscale', 1.0))
                    if abs(yscale - 1e-3) < 1e-10:
                        unit = "kJ/mol"
                    
                    # Get plotting mode: System (default) or Phases
                    plot_mode = config.get('plot_mode', 'System')
                    
                    if not ylabel:
                        prefix = "Phase" if plot_mode == 'Phases' else "System"
                        if prop == 'ACR':
                            ylabel = f"{prefix} Activity"
                        else:
                            ylabel = f"{prefix} {prop_name} ({unit})".strip()
                    
                    uq_phases = config.get('uq_phases', [])
                    act_comp = config.get('act_component', x_comp)
                    
                    if prop == 'ACR' or (plot_mode == 'Phases' and uq_phases):
                        phases_to_plot = uq_phases if uq_phases else phaseL
                        # Calculate and plot properties of each phase
                        logging.info(f"Calling plot_phase_property for phases: {phases_to_plot}, activity component: {act_comp}")
                        fig = plot_phase_property(dbf, comps, phases_to_plot, conds, params_subset, prop, coordD, xlabel=xlabel, ylabel=ylabel, yscale=yscale, xlim=xlim, act_comp=act_comp)
                    else:
                        # Execute thermodynamic calculation (equilibrium) to get equilibrium system properties
                        logging.info("Calling eq_calc_samples for Property UQ (System Equilibrium)...")
                        eq = eq_calc_samples(dbf, conds, params_subset, comps=comps, phases=phaseL, client=client, symbols_to_fit=symbols)
                        
                        if eq is None:
                            raise RuntimeError("Property equilibrium calculation returned None.")

                        mu0 = None
                        if prop == 'ACR':
                            # Calculate reference state
                            logging.info(f"Calculating mu0 for component {act_comp}...")
                            mu0_list = []
                            # Determine reference state phase: if single phase plot, use that phase; otherwise use stable phase among all phases
                            ref_phases = uq_phases if (plot_mode == 'Phases' and uq_phases) else phaseL
                            
                            for i in range(params_subset.shape[0]):
                                try:
                                    param_dict = {sym: val for sym, val in zip(symbols, params_subset[i])}
                                    # Reference state: equilibrium chemical potential of pure component at the same temperature
                                    temp = float(config.get('uq_T_fixed', 1000)) if vary == 'X' else float(config.get('uq_T_min', 300))
                                    try:
                                        res_ref = equilibrium(dbf, comps, ref_phases, {v.P: 101325, v.T: temp, v.X(act_comp): 0.999}, parameters=param_dict)
                                    except ValueError:
                                        # If act_comp is dependent component, try to set another component to 0.001
                                        other_comp = next((c for c in comps if c != 'VA' and c != act_comp), None)
                                        if other_comp:
                                            res_ref = equilibrium(dbf, comps, ref_phases, {v.P: 101325, v.T: temp, v.X(other_comp): 0.001}, parameters=param_dict)
                                        else:
                                            raise
                                        
                                    if 'component' in res_ref.dims:
                                        mu0_val = float(res_ref.MU.sel(component=act_comp).values.flatten()[0])
                                    else:
                                        mu0_val = float(res_ref.MU.values.flatten()[0])
                                    mu0_list.append(mu0_val)
                                except Exception as e:
                                    logging.warning(f"Failed to calculate mu0 for sample {i}: {e}")
                                    mu0_list.append(np.nan)
                            mu0 = np.array(mu0_list)

                        # Pass equilibrium object to plot_property for uncertainty visualization
                        fig = plot_property(eq, prop, coordD, xlabel=xlabel, ylabel=ylabel, yscale=yscale, xlim=xlim, datasets=raw_exp_data, comps=comps, mu0=mu0, T=float(config.get('uq_T_fixed', 1000)) if vary == 'X' else 1000, x_comp=x_comp, act_comp=act_comp)
                    
                    buf = io.BytesIO()
                    fig.savefig(buf, format='png', bbox_inches='tight')
                    buf.seek(0)
                    img_str = base64.b64encode(buf.read()).decode('utf-8')
                    
                    return {
                        "status": "success",
                        "images": [img_str],
                        "message": f"Property UQ for {prop} completed successfully. {sample_info}",
                        "terminal_output": f"Successfully completed property UQ.\n{sample_info}\nOutput image generated."
                    }
                except Exception as e:
                    logging.error(f"Error in property calculation/plotting: {e}")
                    logging.error(traceback.format_exc())
                    raise RuntimeError(f"Failed to generate property plot: {e}")

            elif calc_type == "trace":
                n_params = params.shape[1]
                n_samples = params.shape[0]
                trace_reshaped = params.reshape(1, n_samples, n_params)
                fig = plot_trace(trace_reshaped)
                sample_info = f"Trace shape: {params.shape}"

            else:
                raise HTTPException(status_code=400, detail="Unknown calculation type")

            buf = io.BytesIO()
            fig.savefig(buf, format='png', bbox_inches='tight')
            buf.seek(0)
            img_str = base64.b64encode(buf.read()).decode('utf-8')
            
            return {
                "status": "success",
                "image": img_str,
                "message": f"Calculation {calc_type} completed successfully. {sample_info}",
                "terminal_output": f"Successfully completed {calc_type}.\n{sample_info}\nOutput image generated."
            }

        except Exception as e:
            logging.error(f"Top-level error: {e}")
            logging.error(traceback.format_exc())
            tb_lines = traceback.format_exception(type(e), e, e.__traceback__)
            detailed_error = f"Error during {req.calculation_type} calculation:\nException: {str(e)}\nTraceback:\n{''.join(tb_lines)}"
            return {
                "status": "error",
                "message": str(e),
                "terminal_output": detailed_error,
                "traceback": traceback.format_exc()
            }

@router.post("/analysis/calculate")
async def calculate_analysis(req: AnalysisRequest):
    loop = asyncio.get_event_loop()
    try:
        return await loop.run_in_executor(get_executor(), _calculate_analysis_sync, req)
    except BrokenProcessPool as e:
        logging.error(f"Executor broken: {e}. Resetting executor.")
        reset_executor()
        raise HTTPException(status_code=500, detail="Calculation process crashed. Please try again.")
    except Exception as e:
        logging.error(f"Executor error: {e}")
        raise HTTPException(status_code=500, detail=f"Calculation process failed: {str(e)}")
