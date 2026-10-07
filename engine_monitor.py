import uvicorn, io, json, numpy as np, logging, asyncio, traceback, re, threading, sys, time, base64
import pandas as pd
import os
from dask.distributed import LocalCluster, Client

# --- NumPy 2.0 & ESPEI Compatibility Hardening ---
if not hasattr(np, "float_"):
    np.float_ = np.float64
if not hasattr(np, "int_"):
    np.int_ = int

# --- ESPEI TRACE LEVEL ---
TRACE_LEVEL = 15
logging.addLevelName(TRACE_LEVEL, "TRACE")

# --- LOGGING SUPPRESSION ---
import logging
logging.getLogger("distributed").setLevel(logging.CRITICAL)
logging.getLogger("distributed.comm.core").setLevel(logging.CRITICAL)
logging.getLogger("distributed.nanny").setLevel(logging.CRITICAL)
logging.getLogger("distributed.worker.state_machine").setLevel(logging.CRITICAL)
logging.getLogger("distributed.worker").setLevel(logging.CRITICAL)
logging.getLogger("distributed.scheduler").setLevel(logging.CRITICAL)

# --- 🛠️ ESPEI KERNEL MONKEY PATCH ---
import espei
from espei.error_functions import zpf_error

import tinydb.database
import tinydb.queries

# =====================================================================
# 🛡️ TINYDB DASK PICKLING FIREWALL (Ultimate recursive dead-loop interceptor)
# Completely block RecursionError caused by blind forwarding of __getattr__ when cloudpickle serializes TinyDB instances
# =====================================================================

# 1. Intercept magic method forwarding of TinyDB main class
_orig_db_getattr = tinydb.database.TinyDB.__getattr__
def _safe_db_getattr(self, name):
    if name.startswith('__') and name.endswith('__'):
        raise AttributeError(f"TinyDB block: no internal attribute '{name}'")
    return _orig_db_getattr(self, name)
tinydb.database.TinyDB.__getattr__ = _safe_db_getattr

# 2. Intercept magic method forwarding of Query class
_orig_query_getattr = tinydb.queries.Query.__getattr__
def _safe_query_getattr(self, name):
    if name.startswith('__') and name.endswith('__'):
        raise AttributeError(f"Query block: no internal attribute '{name}'")
    return _orig_query_getattr(self, name)
tinydb.queries.Query.__getattr__ = _safe_query_getattr

# =====================================================================


# --- 2. GLOBAL DASK EMCEE WRAPPER ---
# Must be defined in global scope to prevent cloudpickle from attempting to serialize the local closure of worker_thread (e.g. queue, loop)
class EmceeDaskWrapper:
    def __init__(self, dask_client):
        self.client = dask_client
        
    def map(self, func, iterable):
        futures = self.client.map(func, iterable)
        return self.client.gather(futures)
# --------------------------------------------

# --- Dask Tokenization Fix for emcee ---
# Fixes: dask.tokenize.TokenizationError: Object <emcee.ensemble._function_wrapper ...> cannot be deterministically hashed.
try:
    from dask.base import normalize_token
    import emcee
    import numpy as np
    # emcee uses _function_wrapper to wrap the likelihood function
    wrapper_type = getattr(emcee.ensemble, '_function_wrapper', None)
    if wrapper_type:
        @normalize_token.register(wrapper_type)
        def normalize_emcee_wrapper(obj):
            # Extract the underlying function and arguments for hashing
            return (type(obj).__name__, getattr(obj, 'f', None), getattr(obj, 'args', None), getattr(obj, 'kwargs', None))
except Exception:
    pass

def bulletproof_extract_pot_conds(conditions, index):
    from pycalphad import variables as v
    pot_conds = {}
    for cond_key, cond_val in conditions.items():
        if cond_key not in ['T', 'P']:
            continue
        try:
            if isinstance(cond_val, (list, np.ndarray, tuple)):
                try:
                    current_val = cond_val[index]
                    pot_conds[getattr(v, cond_key)] = float(np.atleast_1d(current_val).flat[0])
                except IndexError:
                    pot_conds[getattr(v, cond_key)] = float(np.atleast_1d(cond_val).flat[0])
            else:
                pot_conds[getattr(v, cond_key)] = float(cond_val)
        except:
            continue
    return pot_conds

zpf_error._extract_pot_conds = bulletproof_extract_pot_conds

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import tinydb
from tinydb.storages import MemoryStorage

from pycalphad import Database, variables as v, equilibrium, calculate
from espei.optimizers.opt_mcmc import EmceeOptimizer
from espei.utils import bib_marker_map
from espei.core_utils import ravel_zpf_values
from pycalphad.plot.utils import phase_legend
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.lines as mlines
from mpl_toolkits.mplot3d import Axes3D
import matplotlib.ticker as mticker

# Safe import for seaborn with fallback palette
try:
    import seaborn as sns
    HAS_SEABORN = True
except ImportError:
    HAS_SEABORN = False

router = APIRouter()
mcmc_interrupt = threading.Event()
current_mcmc_run_id = None
R = 8.3145

# =============================================================================
# PART 1: MCMC OPTIMIZATION ENGINE
# =============================================================================

class McmcRequest(BaseModel):
    tdb_content: str
    datasets: List[Dict[str, Any]]
    config: Dict[str, Any]
    phase_model: Optional[Dict[str, Any]] = None

def normalize_dataset(ds):
    if not isinstance(ds, dict): return ds
    ds = json.loads(json.dumps(ds))
    if 'components' in ds:
        ds['components'] = [str(c).upper().strip() for c in ds['components']]
    if 'phases' in ds:
        if isinstance(ds['phases'], str):
            ds['phases'] = [ds['phases']]
        ds['phases'] = [str(p).upper().strip() for p in ds['phases']]
    if 'output' in ds:
        ds_output = str(ds['output']).upper().strip()
        # Aliases normalization
        if ds_output in ['ACTIVITY']: ds_output = 'ACR'
        elif ds_output in ['ENTHALPY', 'HM', 'HM_MIX', 'MIXING ENTHALPY']: ds_output = 'HM_MIX'
        elif ds_output in ['ENTROPY', 'SM', 'SM_MIX']: ds_output = 'SM_MIX'
        elif ds_output in ['HEAT CAPACITY', 'CPM']: ds_output = 'CPM'
        ds['output'] = ds_output
    if 'conditions' in ds:
        new_conds = {}
        for k, val in ds['conditions'].items():
            key = str(k).upper().strip()
            if isinstance(val, (list, tuple)):
                arr = np.array(val)
                new_conds[key] = arr.flatten().tolist() if arr.ndim > 1 else val
            else:
                new_conds[key] = val
        ds['conditions'] = new_conds
    
    if ds.get('output') == 'ZPF' and 'values' in ds:
        new_values = []
        for eq in ds['values']:
            new_eq = []
            for vertex in eq:
                if isinstance(vertex, list) and len(vertex) > 0:
                    vertex[0] = str(vertex[0]).upper().strip()
                    if len(vertex) > 1 and isinstance(vertex[1], list):
                        vertex[1] = [str(c).upper().strip() for c in vertex[1]]
                new_eq.append(vertex)
            new_values.append(new_eq)
        ds['values'] = new_values

    return ds

def get_versions_header():
    import pycalphad, dask, distributed, symengine, emcee
    return [
        f"INFO:espei.espei_script - espei version       {espei.__version__}",
        f"INFO:espei.espei_script - pycalphad version   {pycalphad.__version__}",
        f"INFO:espei.espei_script - dask version        {dask.__version__}",
        f"INFO:espei.espei_script - distributed version {distributed.__version__}",
        f"INFO:espei.espei_script - symengine version   {getattr(symengine, '__version__', 'unknown')}",
        f"INFO:espei.espei_script - emcee version       {getattr(emcee, '__version__', 'unknown')}",
        "INFO:espei.espei_script - ESPEI optimization engine initialized successfully."
    ]

def robust_pythonize(obj):
    if isinstance(obj, np.ndarray):
        return np.where(np.isfinite(obj), obj, 0).tolist()
    if isinstance(obj, (np.floating, float)):
        return float(obj) if np.isfinite(obj) else 0.0
    if isinstance(obj, (np.integer, int)):
        return int(obj)
    if isinstance(obj, (list, tuple)):
        return [robust_pythonize(item) for item in obj]
    if isinstance(obj, dict):
        return {k: robust_pythonize(v) for k, v in obj.items()}
    return obj

class MCMCLogHandler(logging.Handler):
    def __init__(self, queue, loop):
        super().__init__()
        self.queue = queue
        self.loop = loop
        self.setFormatter(logging.Formatter('%(levelname)s:%(name)s - %(message)s'))
    def emit(self, record):
        try:
            # 1. Intercept DEBUG level logs
            if record.levelno == logging.DEBUG: return
            
            verbosity = getattr(self, '_verbosity', 1)
            
            # 2. If Verbosity 1 is selected in frontend, strictly intercept TRACE(15) level logs
            if verbosity < 2 and record.levelno == 15: return
            
            if record.levelno < self.level: return
            msg = self.format(record)
            if not msg.strip(): return
            
            # Smart log throttling for high-frequency logs
            if "Proposal - " in msg:
                # Proposals are very noisy, throttle them if verbosity < 2
                if verbosity < 2: return
                
                if not hasattr(self, '_p_counter'): self._p_counter = 0
                self._p_counter += 1
                if self._p_counter % 5 != 0: return # Only show every 5th proposal
                
            if "Likelihood - " in msg:
                # Likelihood summaries are key, we show them more often but still throttle if extremely high count
                if verbosity < 1: return
                
                if not hasattr(self, '_l_counter'): self._l_counter = 0
                self._l_counter += 1
                
                iterations = getattr(self, '_iterations_for_log', 500)
                if iterations > 2000:
                    if self._l_counter % 20 != 0: return # Very aggressive for 2000+
                elif iterations > 1000:
                    if self._l_counter % 10 != 0: return # Aggressive for 1000+
                elif iterations > 500:
                    if self._l_counter % 4 != 0: return # Moderately aggressive
            
            self.loop.call_soon_threadsafe(self.queue.put_nowait, {"type": "log", "data": msg})
        except: pass

@router.post("/run-mcmc")
async def run_mcmc(req: McmcRequest):
    """
    Independent MCMC Optimization Entry Point.
    Handles streaming logs and parameter fitting.
    """
    global current_mcmc_run_id
    import uuid
    current_mcmc_run_id = str(uuid.uuid4())
    my_run_id = current_mcmc_run_id
    
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue()
    mcmc_interrupt.clear()
    handler = MCMCLogHandler(queue, loop)
    # Inject metadata for smart throttling
    handler._verbosity = int(req.config.get('output', {}).get('verbosity', 2))
    handler._iterations_for_log = req.config.get('iterations', 500)
    
    # Get verbosity from frontend config, default is 2 (verbose mode)
    verbosity = int(req.config.get('output', {}).get('verbosity', 2))
    
    # Map to Python log level
    if verbosity == 0:
        log_level = logging.WARNING
    elif verbosity == 1:
        log_level = logging.INFO
    else:
        # For verbosity 2, we need TRACE level to see acceptance ratios and detailed props
        log_level = TRACE_LEVEL
        
    # Configure Logging for ESPEI
    logger = logging.getLogger('espei')
    # Remove existing handlers to avoid double logging
    for h in logger.handlers[:]:
        logger.removeHandler(h)
        
    logger.setLevel(log_level)
    handler.setLevel(log_level)
    logger.addHandler(handler)

    # --- 🛡️ NOISE REDUCTION: Suppress high-frequency status logs ---
    logging.getLogger('espei.error_functions.zpf_error').setLevel(logging.WARNING)
    logging.getLogger('espei.error_functions.equilibrium_error').setLevel(logging.WARNING)
    logging.getLogger('espei.error_functions.non_equilibrium_thermochemical_error').setLevel(logging.WARNING)
    logging.getLogger('pycalphad.equilibrium').setLevel(logging.ERROR)
    logging.getLogger('pycalphad.codegen.callables').setLevel(logging.ERROR)
    
    print(f"DEBUG: /run-mcmc route activated for {req.config.get('iterations')} iterations.")
    
    async def event_generator():
        try:
            yield f"data: {json.dumps({'type': 'log', 'data': '[SYSTEM] Stream Connection Established. Initializing ESPEI Kernel...'})}\n\n"
            
            for line in get_versions_header():
                yield f"data: {json.dumps({'type': 'log', 'data': line})}\n\n"
            
            print("DEBUG: event_generator starting...")
            
            clean_tdb = req.tdb_content.replace('\r\n', '\n').replace('\r', '\n').replace('\xa0', ' ')
            dbf = Database(clean_tdb)
            db_mem = tinydb.TinyDB(storage=MemoryStorage)
            for ds in req.datasets: db_mem.insert(normalize_dataset(ds))
            
            # Log the number of loaded datasets
            yield f"data: {json.dumps({'type': 'log', 'data': f'[SYSTEM] Loaded {len(req.datasets)} dataset records into memory.'})}\n\n"
            
            def worker_thread():
                try:
                    print("DEBUG: worker_thread starting...")
                    logger.info("DEBUG: Starting worker_thread")
                    
                    # 1. Setup Parallel Execution
                    from multiprocessing.pool import ThreadPool
                    
                    client = None
                    cluster = None
                    mcmc_pool = None
                    try:
                        cores = int(req.config.get('cores', 4))
                        if cores > 1:
                            logger.info(f"🚀 [DASK] Initializing Pure Dask Multi-processing Environment (Cores: {cores})...")
                            import dask
                            # CRITICAL FIX: Dask's unmanaged memory check pauses workers when they hit 80% memory,
                            # causing the exact freeze the user was experiencing. We MUST disable the pause.
                            dask.config.set({
                                "distributed.worker.memory.target": False,  
                                "distributed.worker.memory.spill": False,   
                                "distributed.worker.memory.pause": False,   
                                "distributed.worker.memory.terminate": False,
                                "distributed.scheduler.worker-ttl": None
                            })
                            
                            # Dynamically allocate memory based on core count to prevent OOM
                            # Max container mem is ~10.6GB. Reserve 2.5GB for main Node/Python processes.
                            # The remaining 8GB is divided among the workers.
                            safe_mem = max(0.8, 8.0 / cores) 
                            
                            cluster = LocalCluster(
                                n_workers=cores, 
                                threads_per_worker=1, 
                                processes=True, 
                                dashboard_address=None,
                                memory_limit=f"{safe_mem:.2f}GB",
                                silence_logs=logging.WARNING
                            )
                            client = Client(cluster)
                            
                            try:
                                def setup_worker_logging(lvl):
                                    import logging
                                    logging.addLevelName(15, "TRACE")
                                    logging.getLogger("espei").setLevel(lvl)
                                    logging.getLogger('espei.error_functions.zpf_error').setLevel(logging.WARNING)
                                    logging.getLogger('espei.error_functions.equilibrium_error').setLevel(logging.WARNING)
                                    logging.getLogger('espei.error_functions.non_equilibrium_thermochemical_error').setLevel(logging.WARNING)
                                    logging.getLogger('pycalphad.equilibrium').setLevel(logging.ERROR)
                                    logging.getLogger('pycalphad.codegen.callables').setLevel(logging.ERROR)
                                
                                client.run(setup_worker_logging, log_level)
                                client.forward_logging(logger_name="espei", level=log_level)
                                logger.info("DEBUG: Dask worker logging successfully configured and forwarded.")
                            except Exception as e:
                                logger.warning(f"DEBUG: Could not configure worker logs: {e}")
                                
                            emcee_pool = EmceeDaskWrapper(client)
                            logger.info(f"DEBUG: Parallel Environment Ready (Dask Multi-processing)")
                        else:
                            logger.info("DEBUG: Single core requested, using serial.")
                    except Exception as err:
                        logger.warning(f"DEBUG: Failed to initialize parallel environment: {err}. Falling back to serial.")
                        mcmc_pool = None
                    
                    # 2. Monkey Patch emcee.EnsembleSampler.sample for Real-Time Monitoring
                    import emcee
                    original_sample = emcee.EnsembleSampler.sample
                    
                    def patched_sample(self, *args, **kwargs):
                        # Generator that yields from original sample and updates monitor
                        logger.info(f"DEBUG: patched_sample called with {len(args)} args")
                        generator = original_sample(self, *args, **kwargs)
                        
                        # Get verbose level set by frontend (0=Warning, 1=Info/Progress bar, 2=Trace/Verbose)
                        verbosity = int(req.config.get('output', {}).get('verbosity', 2))
                        
                        trace_file = req.config.get('output', {}).get('tracefile', 'trace.npy')
                        prob_file = req.config.get('output', {}).get('probfile', 'prob.npy')
                        
                        for i, result in enumerate(generator):
                            # --- Check for Interrupt ---
                            if mcmc_interrupt.is_set() or current_mcmc_run_id != my_run_id:
                                logger.info("DEBUG: MCMC Interrupted by user signal or new run started in sampler.")
                                break

                            # Smarter interval: infrequent updates for long runs to save memory/CPU
                            iterations_for_log = req.config.get('iterations', 500)
                            if iterations_for_log > 2000:
                                update_interval = max(50, iterations_for_log // 40)
                            elif iterations_for_log > 1000:
                                update_interval = max(20, iterations_for_log // 50)
                            else:
                                update_interval = max(5, iterations_for_log // 100)
                            
                            # 2. Progress Log Output
                            # We show a clean progress line at regular intervals to keep the UI active
                            if i % max(1, update_interval // 2) == 0:
                                try:
                                    lnprobs = result[1]
                                    best_prob = np.max(lnprobs)
                                    # This log will flow through the Handler and appear in the console
                                    logger.info(f"⏳ [MCMC] Step {i:04d}/{iterations_for_log} | Best Probability: {best_prob:.2f}")
                                except Exception:
                                    pass
                                    
                            if verbosity <= 1:
                                # Simulate tqdm progress bar
                                bar_length = 30
                                filled = int(bar_length * ((i + 1) / iterations_for_log))
                                bar_str = '=' * filled + ' ' * (bar_length - filled)
                                logger.info(f"[{bar_str}] ({i + 1} of {iterations_for_log})")
                            
                            # [Force extract and broadcast TRACE data in main process, ignoring Dask isolation]
                            if verbosity >= 2:
                                try:
                                    lnprobs = result[1] # Get log-likelihoods of all Walkers in the current step
                                    best_prob = np.max(lnprobs)
                                    mean_prob = np.mean(lnprobs)
                                    logger.log(15, f"🔥 [TRACE] Iteration {i:03d} | Best LnProb: {best_prob:.2f} | Mean LnProb: {mean_prob:.2f} | Walkers: {len(lnprobs)}")
                                except Exception:
                                    pass

                            # 3. Custom Monitoring Logic (UI Charts/Traces)
                            try:
                                if i % update_interval == 0 or i == 0 or i == iterations_for_log - 1: # Throttled for UI stability
                                    # REMOVED gc.collect() - it freezes the inner loop and causes timeout crashes!
                                    # Extract data (Compatible with emcee 2.x and 3.x)
                                    if hasattr(self, 'get_chain'):
                                        trace = self.get_chain()[:i+1]
                                        lnprob = self.get_log_prob()[:i+1]
                                    else:
                                        trace = np.transpose(self.chain, (1, 0, 2))[:i+1]
                                        lnprob = np.transpose(self.lnprobability, (1, 0))[:i+1]
                                    
                                    # --- AGGRESSIVE DOWNSAMPLING FOR LIVE VIEW ---
                                    # 1. Limit Walkers: Pick a representative set of walkers
                                    num_walkers = trace.shape[1]
                                    num_params = trace.shape[2]
                                    # The user explicitly requested that the number of chains visualized matches the number of parameters
                                    # We cap it at 32 to ensure browser stability.
                                    MAX_LIVE_CHAINS = min(32, num_params)
                                    if num_walkers > MAX_LIVE_CHAINS:
                                        wc_indices = np.linspace(0, num_walkers - 1, MAX_LIVE_CHAINS, dtype=int)
                                        trace_viz = trace[:, wc_indices, :]
                                        lnprob_viz = lnprob[:, wc_indices]
                                    else:
                                        trace_viz = trace
                                        lnprob_viz = lnprob

                                    # 2. Limit Points: Only send a small window of recent history or a sparse global view
                                    # Target a maximum of ~6,000 total numeric values per payload to avoid UI stutter.
                                    values_per_step = MAX_LIVE_CHAINS * num_params
                                    target_pts = max(15, min(80, 6000 // max(1, values_per_step)))
                                    MAX_LIVE_PTS = target_pts
                                    num_steps = trace_viz.shape[0]
                                    if num_steps > MAX_LIVE_PTS:
                                        pt_stride = max(1, num_steps // MAX_LIVE_PTS)
                                        pt_indices = list(range(0, num_steps, pt_stride))
                                        if pt_indices[-1] != num_steps - 1:
                                            pt_indices.append(num_steps - 1)
                                        # Use 2 decimal places for trace to save massive JSON bandwidth
                                        send_trace = np.round(trace_viz[pt_indices], 2)
                                        send_lnprob = np.round(lnprob_viz[pt_indices], 1)
                                        indices = pt_indices
                                    else:
                                        send_trace = np.round(trace_viz, 2)
                                        send_lnprob = np.round(lnprob_viz, 1)
                                        indices = list(range(num_steps))
                                    
                                    progress_pkt = {
                                        "type": "progress",
                                        "iteration": i,
                                        "indices": indices,
                                        "trace": send_trace.tolist() if hasattr(send_trace, 'tolist') else robust_pythonize(send_trace),
                                        "lnprob": send_lnprob.tolist() if hasattr(send_lnprob, 'tolist') else robust_pythonize(send_lnprob)
                                    }
                                    loop.call_soon_threadsafe(queue.put_nowait, progress_pkt)
                            except Exception as e:
                                logger.error(f"Monitor Error at iteration {i}: {e}")
                            # -------------------------------
                            yield result
                    
                    # Apply Patch
                    emcee.EnsembleSampler.sample = patched_sample
                    logger.info("DEBUG: Applied emcee monkey patch for real-time monitoring.")

                    # 3. Initialize Optimizer
                    emcee_pool = None
                    if client:
                        logger.info("DEBUG: Initializing EmceeOptimizer with wrapped Dask Client...")
                        # Must pass the wrapper, not the bare client
                        emcee_pool = EmceeDaskWrapper(client)
                    elif mcmc_pool:
                        # Secondary priority: ThreadPool multithreading (only as fallback)
                        logger.info(f"DEBUG: Initializing EmceeOptimizer with ThreadPool ({cores} walkers)...")
                        emcee_pool = mcmc_pool
                    else:
                        # Lowest priority: Serial
                        logger.info("DEBUG: Initializing EmceeOptimizer (Serial Mode)...")
                    
                    # Pass emcee_pool to completely eliminate Future type errors
                    optimizer = EmceeOptimizer(dbf=dbf, phase_models=req.phase_model, scheduler=emcee_pool)
                    logger.info("DEBUG: EmceeOptimizer initialized.")
                    
                    try:
                        logger.info("DEBUG: Starting optimizer.fit()...")
                        
                        symbols = [str(s) for s in req.config.get('symbols', [])]
                        iterations = req.config.get('iterations', 500)
                        chains_per_parameter = req.config.get('chains_per_parameter', 2)
                        
                        if not symbols:
                            from pduq_core import database_symbols_to_fit
                            symbols = database_symbols_to_fit(dbf)
                            logger.info(f"Auto-extracted symbols to fit: {symbols}")

                        # IMPORTANT: ESPEI automatically sorts symbols internally. We must sort them here 
                        # so that our mapping matches the param order in the generated trace!
                        symbols = sorted(symbols)
                        logger.info(f"DEBUG: Config - Sorted Symbols: {symbols}, Iterations: {iterations}, Chains: {chains_per_parameter}")
                        
                        if len(db_mem) == 0:
                            raise ValueError("No datasets loaded in MemoryStorage. Cannot optimize.")

                        # Extract diagnostic info
                        sys_comps = [str(e).upper() for e in dbf.elements]
                        sys_phases = list(dbf.phases.keys())
                        
                        ds_info = []
                        for i, ds in enumerate(db_mem.all()):
                            ds_c = [str(c) for c in ds.get('components', [])]
                            ds_p = [str(c) for c in ds.get('phases', [])]
                            
                            c_ok = set(ds_c).issubset(set(sys_comps))
                            # For ZPF datasets, phases might be inline, so ds_p could be empty or '*':
                            p_ok = True
                            if ds_p and ds_p != ['*']:
                                p_ok = set(ds_p).issubset(set(sys_phases))
                            
                            status = "OK" if (c_ok and p_ok) else "MISMATCH"
                            if not c_ok: status += f" (Comps {ds_c} not in {sys_comps})"
                            if not p_ok: status += f" (Phases {ds_p} not in {sys_phases})"
                            
                            ds_info.append(f"[{i}] {ds.get('output')} | {status}")
                        
                        loop.call_soon_threadsafe(queue.put_nowait, {
                            "type": "log",
                            "data": f"DEBUG: Dataset Compatability Check (ESPEI strict matching):\n" + "\n".join(ds_info[:50])
                        })

                        # Ensure VA is appended specifically to dataset if it is in sys_comps, as ESPEI expects it
                        has_va = 'VA' in sys_comps
                        if has_va:
                            for ds in db_mem.all():
                                if 'components' in ds and 'VA' not in [c.upper() for c in ds['components']]:
                                    ds['components'].append('VA')
                                    db_mem.update({'components': ds['components']}, doc_ids=[ds.doc_id])

                        # Remove abort_watcher to prevent crashing Dask
                        
                        try:
                            # REMOVED: save_interval, tracefile, probfile arguments
                            optimizer.fit(
                                symbols=symbols, 
                                datasets=db_mem, 
                                iterations=iterations, 
                                chains_per_parameter=chains_per_parameter,
                                deterministic=True
                            )
                            optimizer._fit_complete = True
                        except Exception as fit_err:
                            optimizer._fit_complete = True
                            # Log the error but don't re-raise immediately if it was interrupted 
                            # or if we want to salvage the partial trace
                            if mcmc_interrupt.is_set() or current_mcmc_run_id != my_run_id:
                                logger.info(f"DEBUG: MCMC fit() interrupted by user or new run. Workers shutting down.")
                            else:
                                logger.error(f"DEBUG: Error during optimizer.fit: {fit_err}")
                                logger.error(traceback.format_exc())
                                # We still proceed to finally to cleanup, then re-raise if not interrupted
                                if not mcmc_interrupt.is_set() and current_mcmc_run_id == my_run_id:
                                   raise fit_err
                        
                        logger.info("DEBUG: optimizer.fit() phase concluded.")
                    except Exception as loop_err:
                        # This catches errors in the outer setup loop as well
                        if not mcmc_interrupt.is_set() and current_mcmc_run_id == my_run_id:
                            logger.error(f"DEBUG: Fatal error in MCMC setup/loop: {loop_err}")
                            raise loop_err
                    finally:
                        if mcmc_pool:
                            try:
                                if mcmc_interrupt.is_set() or current_mcmc_run_id != my_run_id:
                                    mcmc_pool.terminate()
                                else:
                                    mcmc_pool.close()
                                mcmc_pool.join()
                            except: pass
                        
                        # Normal cleanup
                        if client:
                            try: client.shutdown() # Force workers to release huge memory footprint
                            except: pass
                            try: client.close(timeout=2)
                            except: pass
                        if cluster:
                            try: cluster.close(timeout=2)
                            except: pass
                        
                        # Restore original sample method
                        emcee.EnsembleSampler.sample = original_sample
                        logger.info("DEBUG: Cleanup phase complete.")
                    
                    sampler = optimizer.sampler
                    if sampler is None:
                        logger.warning("DEBUG: Sampler not initialized. No data to save.")
                        if not mcmc_interrupt.is_set() and current_mcmc_run_id == my_run_id:
                             loop.call_soon_threadsafe(queue.put_nowait, {"type": "error", "data": "MCMC failed to initialize sampler."})
                        else:
                             loop.call_soon_threadsafe(queue.put_nowait, {"type": "log", "data": "[SYSTEM] Optimization aborted before sampling started."})
                        return

                    trace_arr = sampler.get_chain() if hasattr(sampler, 'get_chain') else np.transpose(sampler.chain, (1, 0, 2))
                    lnprob_arr = sampler.get_log_prob() if hasattr(sampler, 'get_log_prob') else np.transpose(sampler.lnprobability, (1, 0))
                    
                    if mcmc_interrupt.is_set() or current_mcmc_run_id != my_run_id:
                        logger.info("DEBUG: MCMC Aborted/Replaced. Finalizing trace snapshots...")
                    
                    # Update TDB with the BEST parameters found so far
                    if trace_arr.size > 0:
                        try:
                            # Find indices of max likelihood, ignoring uninitialized zeros
                            valid_mask = np.any(trace_arr != 0.0, axis=-1)
                            masked_lnprob = np.where(valid_mask, lnprob_arr, -np.inf)
                            best_flat_idx = np.argmax(masked_lnprob)
                            best_step, best_walker = np.unravel_index(best_flat_idx, lnprob_arr.shape)
                            best_params = trace_arr[best_step, best_walker, :]
                            
                            logger.info(f"DEBUG: Selected optimal parameters from step {best_step} (Prob: {lnprob_arr[best_step, best_walker]:.2f})")
                            for sym, val in zip(symbols, best_params):
                                dbf.symbols[sym] = val
                        except Exception as tdb_upd_err:
                            logger.warning(f"DEBUG: Could not update TDB symbols: {tdb_upd_err}")

                    # Final Save
                    trace_file = req.config.get('output', {}).get('tracefile', 'trace.npy')
                    prob_file = req.config.get('output', {}).get('probfile', 'prob.npy')
                    if trace_arr.size > 0:
                        # Ensure exactly ESPei-compatible data structure: (walkers, iterations, params)
                        np.save(trace_file, np.transpose(trace_arr, (1, 0, 2)))
                        np.save(prob_file, np.transpose(lnprob_arr, (1, 0)))
                        logger.info(f"💾 [SYSTEM] MCMC results saved to disk: {trace_file} & {prob_file}")
                    
                    # --- DOWNSAMPLE FOR FRONTEND VIZ ---
                    if trace_arr.size == 0:
                         loop.call_soon_threadsafe(queue.put_nowait, {"type": "error", "data": "No trace data generated."})
                         return
                    num_w = trace_arr.shape[1]
                    num_params = trace_arr.shape[2]
                    # We want the chains shown to match the number of parameters if possible
                    MAX_VIZ_WALKERS = num_params
                    if num_w > MAX_VIZ_WALKERS:
                        w_idx = np.linspace(0, num_w - 1, MAX_VIZ_WALKERS, dtype=int)
                        trace_v = trace_arr[:, w_idx, :]
                        prob_v = lnprob_arr[:, w_idx]
                    else:
                        trace_v = trace_arr
                        prob_v = lnprob_arr

                    values_per_step = MAX_VIZ_WALKERS * num_params
                    max_pts = max(30, min(150, 15000 // max(1, values_per_step)))

                    if trace_v.shape[0] > max_pts:
                        stride = max(1, trace_v.shape[0] // max_pts)
                        indices = list(range(0, trace_v.shape[0], stride))
                        if indices[-1] != trace_v.shape[0] - 1:
                            indices.append(trace_v.shape[0] - 1)
                        send_trace_arr = np.round(trace_v[indices], 4)
                        send_lnprob_arr = np.round(prob_v[indices], 2)
                    else:
                        indices = list(range(trace_v.shape[0]))
                        send_trace_arr = np.round(trace_v, 4)
                        send_lnprob_arr = np.round(prob_v, 2)

                    success_pkt = {
                        "type": "status", 
                        "status": "success", 
                        "tdb": dbf.to_string(fmt="tdb"), 
                        "trace": send_trace_arr.tolist() if hasattr(send_trace_arr, 'tolist') else robust_pythonize(send_trace_arr),
                        "lnprob": send_lnprob_arr.tolist() if hasattr(send_lnprob_arr, 'tolist') else robust_pythonize(send_lnprob_arr),
                        "indices": indices
                    }
                    loop.call_soon_threadsafe(queue.put_nowait, success_pkt)
                except BaseException as e:
                    logger.error(f"DEBUG: Worker thread fatal error: {e}")
                    logger.error(traceback.format_exc())
                    err_msg = str(e) if str(e) else e.__class__.__name__
                    loop.call_soon_threadsafe(queue.put_nowait, {"type": "error", "data": err_msg})
            
            threading.Thread(target=worker_thread, daemon=True).start()
            
            while True:
                try:
                    # Increase timeout slightly and wait for the worker thread to finish even on interrupt
                    packet = await asyncio.wait_for(queue.get(), timeout=1.0)
                    yield f"data: {json.dumps(robust_pythonize(packet))}\n\n"
                    if isinstance(packet, dict):
                        # Exit when we receive a definitive end-of-process status or an error
                        if packet.get("status") == "success" or packet.get("type") == "error":
                            break
                except asyncio.TimeoutError:
                    # Send a keep-alive comment to prevent proxy timeouts
                    yield ": keep-alive\n\n"
                    
                    # Give it time to finalize even if interrupted
                    if mcmc_interrupt.is_set() or current_mcmc_run_id != my_run_id:
                        # We don't break immediately; we wait for the worker thread 
                        # to push the success packet to the queue.
                        pass
                    continue
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'data': str(e)})}\n\n"
        finally:
            logger.removeHandler(handler)
            
    return StreamingResponse(event_generator(), media_type="text/event-stream")

@router.post("/abort-mcmc")
async def abort_mcmc():
    print("DEBUG: RECEIVED ABORT SIGNAL")
    logging.getLogger('espei').info("🛑 [SYSTEM] Abort Signal Received. Finalizing current step and saving results...")
    mcmc_interrupt.set()
    return {"status": "aborted"}

class DownloadArtifactRequest(BaseModel):
    filepath: str

@router.post("/download-artifact")
async def download_artifact(req: DownloadArtifactRequest):
    import os
    from fastapi.responses import FileResponse
    from fastapi import HTTPException
    
    # Check if this is the fallback request via base64 for old client code
    if getattr(req, "as_json", False):
        import base64
        if not os.path.exists(req.filepath):
            return {"status": "error", "message": f"File not found: {req.filepath}"}
        try:
            with open(req.filepath, "rb") as f:
                b64 = base64.b64encode(f.read()).decode('utf-8')
            return {"status": "success", "content": b64}
        except Exception as e:
            return {"status": "error", "message": f"Failed to read file: {e}"}
            
    if not os.path.exists(req.filepath):
        raise HTTPException(status_code=404, detail="File not found")
        
    return FileResponse(req.filepath, filename=os.path.basename(req.filepath))


# =============================================================================
# PART 3: ANALYSIS HUB (PDUQ Integration)
# =============================================================================

import pduq_core as pduq_engine

class AnalysisRequest(BaseModel):
    tdb_content: str
    trace_path: str
    type: str # PROPERTY, PHASE_FRAC, PHASE_DIAGRAM, INVARIANT, DIST, TRACE
    config: Dict[str, Any]

@router.post("/analyze-mcmc")
async def analyze_mcmc(req: AnalysisRequest):
    try:
        # Load trace
        if not os.path.exists(req.trace_path):
            return {"status": "error", "message": f"Trace file not found: {req.trace_path}"}
        
        trace = np.load(req.trace_path)
        # Ensure shape [nwalkers, nlinks, nparam]
        if trace.ndim == 3 and trace.shape[0] > trace.shape[1]: 
             trace = np.transpose(trace, (1, 0, 2))
        
        flat_params = trace.reshape(-1, trace.shape[-1])
        
        # Parse config
        comps = req.config.get('components')
        phases = req.config.get('phases')
        conds = req.config.get('conditions', {})
        
        # Helper to parse conditions
        parsed_conds = {}
        for k, val in conds.items():
            # Handle range syntax: {"min": 300, "max": 2000, "step": 10}
            if isinstance(val, dict) and 'min' in val and 'max' in val:
                step = val.get('step', 1)
                val = np.arange(val['min'], val['max'], step)
            
            if k == 'T': parsed_conds[v.T] = val
            elif k == 'P': parsed_conds[v.P] = val
            elif k.startswith('X_'): parsed_conds[v.X(k[2:].upper())] = val
            else: parsed_conds[k] = val
            
        clean_tdb = req.tdb_content.replace('\r\n', '\n').replace('\r', '\n').replace('\xa0', ' ')
        dbf = Database(clean_tdb)
        
        if req.type == 'PROPERTY':
            n_samples = int(req.config.get('n_samples', 50))
            indices = np.random.choice(flat_params.shape[0], min(n_samples, flat_params.shape[0]), replace=False)
            subset_params = flat_params[indices, :]
            
            # Ensure T is array if it's the x-axis
            if isinstance(parsed_conds.get(v.T), (int, float)):
                # Maybe X is the axis?
                pass
            
            img = pduq_engine.plot_phase_property(
                dbf, comps, phases, parsed_conds, subset_params, 
                prop=req.config.get('property', 'GM'),
                coordD={},
                xlabel=req.config.get('xlabel'),
                ylabel=req.config.get('ylabel')
            )
            return {"status": "success", "image": img}
            
        elif req.type == 'PHASE_FRAC':
            n_samples = int(req.config.get('n_samples', 20))
            indices = np.random.choice(flat_params.shape[0], min(n_samples, flat_params.shape[0]), replace=False)
            subset_params = flat_params[indices, :]
            
            eq = pduq_engine.eq_calc_samples(dbf, parsed_conds, subset_params, comps=comps, phases=phases)
            img = pduq_engine.plot_phasefracline(eq, {}, xlabel=req.config.get('xlabel'))
            return {"status": "success", "image": img}

        elif req.type == 'PHASE_DIAGRAM':
            # Binary Phase Diagram
            n_samples = int(req.config.get('n_samples', 10))
            indices = np.random.choice(flat_params.shape[0], min(n_samples, flat_params.shape[0]), replace=False)
            subset_params = flat_params[indices, :]
            
            # We need to calculate equilibrium over a grid
            # User should provide T range and X range in conds
            # e.g. T: [300, ... 2000], X_MG: [0, ... 1]
            
            eq = pduq_engine.eq_calc_samples(dbf, parsed_conds, subset_params, comps=comps, phases=phases)
            
            # Identify X component
            x_comp = req.config.get('x_component', comps[0])
            img = pduq_engine.plot_superimposed(eq, comp=x_comp)
            return {"status": "success", "image": img}
            
        elif req.type == 'INVARIANT':
            n_samples = int(req.config.get('n_samples', 10))
            indices = np.random.choice(flat_params.shape[0], min(n_samples, flat_params.shape[0]), replace=False)
            subset_params = flat_params[indices, :]
            
            Tv, phv, bndv = pduq_engine.invariant_samples(
                dbf, subset_params, 
                X=req.config.get('X_guess', 0.5),
                P=req.config.get('P', 101325),
                Tl=req.config.get('Tl', 300),
                Tu=req.config.get('Tu', 2000),
                comp=req.config.get('comp'),
                comps=comps, phases=phases
            )
            
            return {
                "status": "success", 
                "data": {
                    "Tv": Tv.tolist(),
                    "phv": [list(p) for p in phv],
                    "bndv": bndv.tolist()
                }
            }

        elif req.type == 'TRACE':
            img_list = pduq_engine.plot_trace(trace, plabelL=req.config.get('labels'))
            return {"status": "success", "images": img_list}
            
        return {"status": "error", "message": "Unknown type"}
        
    except Exception as e:
        return {"status": "error", "message": str(e), "trace": traceback.format_exc()}


class TdbSource(BaseModel):
    label: str
    content: str

class ValidationRequest(BaseModel):
    tdb_sources: List[TdbSource]
    datasets: List[Dict[str, Any]]
    type: str 
    config: Dict[str, Any]

def _apply_arctde_style(ax):
    """Academic publishing standard plotting style optimization (ARCTDE Standard V11.3)"""
    plt.rcParams.update({
        'font.family': 'serif',
        'font.serif': ['Times New Roman', 'DejaVu Serif'],
        'mathtext.fontset': 'stix',
        'axes.linewidth': 1.8,
        'xtick.direction': 'in',
        'ytick.direction': 'in',
        'xtick.top': True,
        'ytick.right': True,
        'xtick.major.size': 8,
        'ytick.major.size': 8,
        'axes.labelsize': 16,
        'xtick.labelsize': 12,
        'ytick.labelsize': 12,
        'legend.frameon': True,
        'legend.edgecolor': 'black',
        'legend.fontsize': 11,
        'legend.fancybox': False,
        'figure.autolayout': False
    })
    if ax.name != '3d':
        ax.set_box_aspect(1)
    ax.grid(False)

# -----------------------------------------------------------------------------
# SECTION A: PHASE DIAGRAM (PD) LOGIC
# -----------------------------------------------------------------------------

def _handle_pd_logic(tdb_sources, db_mem, conf, el_names, all_phases, matrix):
    """
    Phase Diagram data harvesting.
    """
    linestyles = ['-', '--', ':', '-.']
    linewidth_options = [1.2, 2.2, 3.2, 4.2]
    x_el = (conf.get('target_comp') or (el_names[1] if len(el_names) > 1 else el_names[0])).upper()
    t_min = float(conf.get('t_min', 300))
    t_max = float(conf.get('t_max', 2000))
    t_step = float(conf.get('t_step', 20))
    
    for idx, source in enumerate(tdb_sources):
        dbf = Database(source.content)
        ls = linestyles[idx % len(linestyles)]
        lw = linewidth_options[idx % len(linewidth_options)]
        temps = np.arange(t_min, t_max + t_step, t_step)
        x_grid = np.linspace(0, 1, 201)
        
        try:
            res = equilibrium(dbf, el_names + ['VA'], all_phases, {v.P: 101325, v.T: temps, v.X(x_el): x_grid})
            for ph_name in all_phases:
                try:
                    ph_eq = res.X.where(res.Phase == ph_name).sel(component=x_el)
                    ph_x = ph_eq.values.reshape(len(temps), len(x_grid), -1)
                    for t_idx, t_val in enumerate(temps):
                        t_row = ph_x[t_idx]
                        valid_x = t_row[~np.isnan(t_row)]
                        if len(valid_x) > 0:
                            x_min, x_max = np.min(valid_x), np.max(valid_x)
                            matrix.append({
                                'Type': 'Calculated', 'T': float(t_val), 'X': float(x_min),
                                'Label': f'Boundary_Lower_{ph_name}', 'Phase': ph_name.upper().strip(),
                                'Source': source.label, 'Linestyle': ls, 'Linewidth': lw, 'Value': None
                            })
                            if not np.isclose(x_min, x_max, atol=1e-4):
                                matrix.append({
                                    'Type': 'Calculated', 'T': float(t_val), 'X': float(x_max),
                                    'Label': f'Boundary_Upper_{ph_name}', 'Phase': ph_name.upper().strip(),
                                    'Source': source.label, 'Linestyle': ls, 'Linewidth': lw, 'Value': None
                                })
                except: continue
        except: continue

    zpf_data = db_mem.search(tinydb.where('output') == 'ZPF')
    bib_keys = sorted({e.get('reference', 'Unknown') for e in zpf_data})
    symbol_map = bib_marker_map(bib_keys)
    eq_dict = ravel_zpf_values(zpf_data, [x_el], conditions={'P': 101325})
    for num_ph, equilibria in eq_dict.items():
        for eq in equilibria:
            for ph_name, comp_dict, ref in eq:
                t_v, x_v = comp_dict.get('T'), comp_dict.get(x_el)
                if t_v is not None and x_v is not None:
                    if t_v < 273.15 and t_min > 273.15: t_v += 273.15
                    matrix.append({
                        'Type': 'Experimental', 'T': float(t_v), 'X': float(x_v),
                        'Label': str(ph_name), 'Phase': str(ph_name).upper().strip(), 'Source': str(ref),
                        'Marker': symbol_map.get(ref, {}).get('markers', {}).get('marker', 'o'),
                        'Value': None, 'Linestyle': None, 'Linewidth': None
                    })

# -----------------------------------------------------------------------------
# SECTION B: ACTIVITY (ACR) LOGIC
# -----------------------------------------------------------------------------

def _handle_acr_logic(tdb_sources, db_mem, conf, el_names, matrix):
    """
    Thermodynamic Activity data harvesting.
    """
    linestyles = ['-', '--', ':', '-.']
    linewidth_options = [1.2, 2.2, 3.2, 4.2]
    x_axis_el = (conf.get('target_comp') or el_names[1]).upper()
    active_probe_el = (conf.get('activity_el') or x_axis_el).upper()
    
    temp = float(conf.get('temperature', 1000))
    target_phase = (conf.get('phase') or 'LIQUID').upper().strip()
    xr = np.linspace(0.001, 0.999, 101)
    
    for idx, source in enumerate(tdb_sources):
        dbf = Database(source.content)
        ls = linestyles[idx % len(linestyles)]
        lw = linewidth_options[idx % len(linewidth_options)]
        try:
            res_p = equilibrium(dbf, el_names + ['VA'], [target_phase], {v.P: 101325, v.T: temp, v.X(active_probe_el): 1-1e-9})
            mu_p = float(res_p.MU.sel(component=active_probe_el).values.flatten()[0])
            res = equilibrium(dbf, el_names + ['VA'], [target_phase], {v.P: 101325, v.T: temp, v.X(x_axis_el): xr})
            yv = np.exp((res.MU.sel(component=active_probe_el).squeeze().values - mu_p) / (R * temp))
            for xv, val in zip(xr, yv):
                matrix.append({
                    'Type': 'Calculated', 'T': float(temp), 'X': float(xv), 'Value': float(val),
                    'Phase': target_phase, 'Source': source.label, 'Linestyle': ls, 'Linewidth': lw, 'Label': f"ACR_{active_probe_el}"
                })
        except: continue

    target_output_str = f"ACR_{active_probe_el}"
    exp_matches = db_mem.search(
        (tinydb.where('output').test(lambda x: str(x).upper() == target_output_str or str(x).upper() == "ACR")) &
        (tinydb.where('phases').test(lambda x: target_phase in [p.upper().strip() for p in x]))
    )
    
    bib_keys = sorted({e.get('reference', 'Unknown') for e in exp_matches})
    symbol_map = bib_marker_map(bib_keys)
    
    for ds in exp_matches:
        ref = ds.get('reference', 'Unknown')
        conds = ds.get('conditions', {})
        ex = None
        ex_raw = conds.get(f'X_{x_axis_el}') or conds.get(x_axis_el)
        if ex_raw is not None:
            ex = np.array(ex_raw).flatten()
        else:
            for el in el_names:
                if el == x_axis_el: continue
                other_val = conds.get(f'X_{el}') or conds.get(el)
                if other_val is not None:
                    ex = 1.0 - np.array(other_val).flatten()
                    break
        
        ey = np.array(ds['values']).flatten()
        if ex is not None and len(ex) == len(ey):
            for xv, yv in zip(ex, ey):
                matrix.append({
                    'Type': 'Experimental', 'X': float(xv), 'Value': float(yv),
                    'Phase': target_phase, 'Source': str(ref), 
                    'Marker': symbol_map.get(ref, {}).get('markers', {}).get('marker', 'o'),
                    'T': conds.get('T'), 'Label': None, 'Linestyle': None, 'Linewidth': None
                })

# -----------------------------------------------------------------------------
# SECTION C: MIXING ENTHALPY (HM_MIX) LOGIC
# -----------------------------------------------------------------------------

def _handle_hm_mix_logic(tdb_sources, db_mem, conf, el_names, matrix):
    """
    Mixing Enthalpy data harvesting.
    """
    linestyles = ['-', '--', ':', '-.']
    linewidth_options = [1.2, 2.2, 3.2, 4.2]
    target_el = (conf.get('target_comp') or el_names[1]).upper()
    temp = float(conf.get('temperature', 1000))
    target_phase = (conf.get('phase') or 'LIQUID').upper().strip()
    xr = np.linspace(0.001, 0.999, 101)
    
    for idx, source in enumerate(tdb_sources):
        dbf = Database(source.content)
        ls = linestyles[idx % len(linestyles)]
        lw = linewidth_options[idx % len(linewidth_options)]
        try:
            yv = [float(calculate(dbf, el_names + ['VA'], target_phase, T=temp, P=101325, points=np.array([[1-v, v]]), output='HM_MIX').HM_MIX.values.flatten()[0]) for v in xr]
            for xv, val in zip(xr, yv):
                matrix.append({
                    'Type': 'Calculated', 'T': float(temp), 'X': float(xv), 'Value': float(val),
                    'Phase': target_phase, 'Source': source.label, 'Linestyle': ls, 'Linewidth': lw, 'Label': f"HM_MIX_{target_phase}"
                })
        except: continue

    exp_matches = db_mem.search(
        (tinydb.where('output').test(lambda x: 'HM_MIX' in str(x).upper() or 'HM_FORM' in str(x).upper())) &
        (tinydb.where('phases').test(lambda x: target_phase in [p.upper().strip() for p in x]))
    )
    
    bib_keys = sorted({e.get('reference', 'Unknown') for e in exp_matches})
    symbol_map = bib_marker_map(bib_keys)
    
    for ds in exp_matches:
        ref = ds.get('reference', 'Unknown')
        conds = ds.get('conditions', {})
        ex = None
        ex_raw = conds.get(f'X_{target_el}') or conds.get(target_el)
        if ex_raw is not None:
            ex = np.array(ex_raw).flatten()
        else:
            for el in el_names:
                if el == target_el: continue
                other_val = conds.get(f'X_{el}') or conds.get(el)
                if other_val is not None:
                    ex = 1.0 - np.array(other_val).flatten()
                    break
        
        if ex is None and 'solver' in ds:
            try:
                solver = ds['solver']
                config = solver['sublattice_configurations'][0]
                for subl_idx, species_list in enumerate(config):
                    if isinstance(species_list, list) and target_el in species_list:
                        sp_idx = species_list.index(target_el)
                        occupancies = np.array(solver['sublattice_occupancies'])
                        ex = occupancies[:, subl_idx, sp_idx].flatten()
                        break
            except: pass

        ey = np.array(ds['values']).flatten()
        if ex is not None and len(ex) == len(ey):
            for xv, yv in zip(ex, ey):
                matrix.append({
                    'Type': 'Experimental', 'X': float(xv), 'Value': float(yv),
                    'Phase': target_phase, 'Source': str(ref), 
                    'Marker': symbol_map.get(ref, {}).get('markers', {}).get('marker', 'o'),
                    'T': conds.get('T'), 'Label': None, 'Linestyle': None, 'Linewidth': None
                })

# -----------------------------------------------------------------------------
# SECTION D: DRIVING FORCE (ZPF RESIDUAL) LOGIC - Academic Optimized Version
# -----------------------------------------------------------------------------

def _handle_driving_force_logic(tdb_sources, db_mem, conf, el_names, all_phases, matrix, diag_logs):
    """
    Gibbs Energy Driving Force mapping for ZPF diagnostic.
    FIXED: Explicitly renders phase boundary black DASHED lines for EACH TDB model at its corresponding Y-plane.
    """
    from pycalphad.core.utils import extract_parameters
    from espei.error_functions.zpf_error import get_zpf_data, calculate_zpf_driving_forces

    x_el = (conf.get('target_comp') or (el_names[1] if len(el_names) > 1 else el_names[0])).upper()
    t_min = float(conf.get('t_min', 300))
    t_max = float(conf.get('t_max', 2000))
    t_step = float(conf.get('t_step', 25)) 
    indep_comp_cond = v.X(x_el)

    # 1. Backgrounds: Extract phase boundary lines for EACH TDB source
    for source in tdb_sources:
        try:
            dbf = Database(source.content)
            temps = np.arange(t_min, t_max + t_step, t_step)
            x_grid = np.linspace(0, 1, 101)
            res = equilibrium(dbf, el_names + ['VA'], all_phases, {v.P: 101325, v.T: temps, v.X(x_el): x_grid})
            
            for ph_name in all_phases:
                try:
                    ph_eq = res.X.where(res.Phase == ph_name).sel(component=x_el)
                    ph_x = ph_eq.values.reshape(len(temps), len(x_grid), -1)
                    for t_idx, t_val in enumerate(temps):
                        t_row = ph_x[t_idx]
                        valid_x = t_row[~np.isnan(t_row)]
                        if len(valid_x) > 0:
                            x_min, x_max = np.min(valid_x), np.max(valid_x)
                            matrix.append({
                                'Type': 'Background', 'T': float(t_val), 'X': float(x_min),
                                'Label': f'BND_L_{ph_name}', 'Phase': ph_name.upper().strip(),
                                'Source': source.label, 'Value': 0.0, 'Linestyle': '--' # Set to dashed
                            })
                            if not np.isclose(x_min, x_max, atol=1e-3):
                                matrix.append({
                                    'Type': 'Background', 'T': float(t_val), 'X': float(x_max),
                                    'Label': f'BND_U_{ph_name}', 'Phase': ph_name.upper().strip(),
                                    'Source': source.label, 'Value': 0.0, 'Linestyle': '--' # Set to dashed
                                })
                except: continue
        except: continue

    # 2. Residuals: Map experimental ZPF driving force calculations
    marker_cycle = ['o', 's', '^', 'D', 'p', 'v', '<', '>', '*', 'h']
    full_comps = sorted(el_names + ['VA'])
    
    z_db = tinydb.TinyDB(storage=MemoryStorage)
    for ds in db_mem.search(tinydb.where('output') == 'ZPF'):
        ds_copy = json.loads(json.dumps(ds))
        conds = ds_copy.get('conditions', {})
        broadcast = ds_copy.get('broadcast_conditions', True)
        num_values = len(ds_copy.get('values', []))
        for k in ['T', 'P']:
            if k in conds:
                val = conds[k]
                if not broadcast:
                    if not isinstance(val, (list, np.ndarray)): conds[k] = [float(val)] * num_values
                    else: conds[k] = [float(x) for x in val]
                else:
                    if isinstance(val, (list, np.ndarray)): conds[k] = float(np.atleast_1d(val).flat[0])
                    else: conds[k] = float(val)
        z_db.insert(ds_copy)

    for idx, eval_src in enumerate(tdb_sources):
        try:
            dbf_eval = Database(eval_src.content)
            marker = marker_cycle[idx % len(marker_cycle)]
            z_data = get_zpf_data(dbf_eval, full_comps, all_phases, z_db, parameters={})
            param_vec = extract_parameters({})[1]
            driving_forces, _ = calculate_zpf_driving_forces(z_data, param_vec)
            
            for entry, entry_dfs in zip(z_data, driving_forces):
                df_offset = 0
                for region in entry["phase_regions"]:
                    for vertex, df in zip(region.vertices, entry_dfs[df_offset:]):
                        df_offset += 1
                        if vertex.has_missing_comp_cond: continue
                        temp = float(region.potential_conds[v.T])
                        if temp < 273.15 and t_min > 273.15: temp += 273.15
                        comp_cond = vertex.comp_conds
                        if indep_comp_cond in comp_cond: xv = float(comp_cond[indep_comp_cond])
                        else:
                            try: xv = 1.0 - float(list(comp_cond.values())[0])
                            except: xv = 0.0
                        matrix.append({
                            'Type': 'Experimental', 'T': temp, 'X': xv, 'Value': float(df),
                            'Source': eval_src.label, 'Phase': 'ZPF_Vertex', 'Marker': marker
                        })
        except: continue

# -----------------------------------------------------------------------------
# SECTION E: VALIDATION ORCHESTRATOR
# -----------------------------------------------------------------------------

@router.post("/validate-mcmc")
async def validate_mcmc(req: ValidationRequest):
    """Modular Validation Dispatcher with Optimized 3D Palette (V11.13)."""
    diag_logs = [f"[SYSTEM] Scientific Dispatcher Initialized at {time.strftime('%H:%M:%S')}"]
    csv_matrix = []
    
    try:
        for source in req.tdb_sources:
            source.content = source.content.replace('\r\n', '\n').replace('\r', '\n').replace('\xa0', ' ')
            
        db_mem = tinydb.TinyDB(storage=MemoryStorage)
        normalized_ds = [normalize_dataset(ds) for ds in req.datasets]
        for ds in normalized_ds: db_mem.insert(ds)
        
        ref_dbf = Database(req.tdb_sources[0].content)
        el_names = sorted([str(e).upper() for e in ref_dbf.elements if str(e).upper() != 'VA'])
        all_phases = sorted(list(ref_dbf.phases.keys()))
        
        if HAS_SEABORN: palette = sns.color_palette("husl", len(all_phases))
        else:
            cmap = plt.get_cmap('tab20')
            palette = [cmap(i % 20) for i in range(len(all_phases))]
        phase_color_map = {name.upper().strip(): palette[i] for i, name in enumerate(all_phases)}
        phase_legend_handles = [mlines.Line2D([], [], color=phase_color_map[ph.upper().strip()], label=ph, linewidth=5) for ph in all_phases]
        
        if req.type == 'PD':
            _handle_pd_logic(req.tdb_sources, db_mem, req.config, el_names, all_phases, csv_matrix)
        elif req.type == 'ACR':
            _handle_acr_logic(req.tdb_sources, db_mem, req.config, el_names, csv_matrix)
        elif req.type == 'HM_MIX':
            _handle_hm_mix_logic(req.tdb_sources, db_mem, req.config, el_names, csv_matrix)
        elif req.type == 'DRIVING_FORCE':
            _handle_driving_force_logic(req.tdb_sources, db_mem, req.config, el_names, all_phases, csv_matrix, diag_logs)

        plt.clf(); plt.close('all')
        
        is_3d = (req.type == 'DRIVING_FORCE')
        if is_3d:
            plt.rcParams.update({
                'font.family': 'serif',
                'font.serif': ['Times New Roman', 'DejaVu Serif'],
                'mathtext.fontset': 'stix',
                'axes.linewidth': 1.0,
                'axes.labelpad': 15
            })
            # --- PROFESSONAL GRAY & WHITE GRID ---
            # Set figure background to white to confine gray to the plotting area
            fig = plt.figure(figsize=(15, 13), dpi=240, facecolor='white')
            ax = fig.add_subplot(111, projection='3d')
            ax.set_facecolor('white') 
            
            # Configure panes with solid professional gray as requested (#EBEBEB)
            pane_color = '#ebebeb'
            ax.xaxis.pane.set_facecolor(pane_color)
            ax.yaxis.pane.set_facecolor(pane_color)
            ax.zaxis.pane.set_facecolor(pane_color)
            ax.xaxis.pane.fill = True
            ax.yaxis.pane.fill = True
            ax.zaxis.pane.fill = True
            
            # Force grid lines to be solid white for high visibility on gray panes
            grid_params = {'color': 'white', 'linestyle': '-', 'linewidth': 1.0, 'alpha': 1.0}
            ax.xaxis._axinfo["grid"].update(grid_params)
            ax.yaxis._axinfo["grid"].update(grid_params)
            ax.zaxis._axinfo["grid"].update(grid_params)
            
            # Use dark spines/lines to outline the 3D cube
            ax.xaxis.line.set_color('black')
            ax.yaxis.line.set_color('black')
            ax.zaxis.line.set_color('black')
            ax.xaxis.line.set_linewidth(1.2)
            ax.yaxis.line.set_linewidth(1.2)
            ax.zaxis.line.set_linewidth(1.2)
        else:
            fig, ax = plt.subplots(figsize=(10, 10), dpi=160)
            _apply_arctde_style(ax)
        
        df = pd.DataFrame(csv_matrix)
        if df.empty: raise ValueError("Calibration matrix is empty.")

        all_request_labels = [s.label for s in req.tdb_sources]
        unique_ordered = []
        baseline_l = next((l for l in all_request_labels if "Initial" in l), None)
        if baseline_l: unique_ordered.append(baseline_l)
        other_labels = sorted(list(set(all_request_labels) - (set([baseline_l]) if baseline_l else set())))
        unique_ordered.extend(other_labels)
        
        model_to_y = {name: float(i) for i, name in enumerate(unique_ordered)}
        num_models = len(unique_ordered)

        # 2.1 Background/Boundary Layer
        type_to_plot = 'Background' if req.type == 'DRIVING_FORCE' else 'Calculated'
        plot_df = df[df['Type'] == type_to_plot]
        
        if not plot_df.empty:
            for keys, group in plot_df.groupby(['Source', 'Phase', 'Label'] if 'Label' in plot_df.columns else ['Source', 'Phase']):
                src_name = keys[0]; ph_name = keys[1]
                if req.type == 'DRIVING_FORCE':
                    clr = '#000000'; alpha = 0.5; lw = 1.0; z_ord = 1; y_plane_val = model_to_y.get(src_name, 0.0)
                else:
                    clr = phase_color_map.get(ph_name.upper().strip(), 'black'); alpha = 0.9
                    lw = group['Linewidth'].iloc[0] if 'Linewidth' in group.columns and pd.notna(group['Linewidth'].iloc[0]) else 3.0
                    z_ord = 10; y_plane_val = 0.0
                ls = group['Linestyle'].iloc[0] if 'Linestyle' in group.columns and pd.notna(group['Linestyle'].iloc[0]) else '-'
                group = group.sort_values('T' if req.type in ['PD', 'DRIVING_FORCE'] else 'X')
                y_col = 'T' if req.type in ['PD', 'DRIVING_FORCE'] else 'Value'
                if is_3d:
                    ax.plot(group['X'], np.full_like(group['X'], y_plane_val), group[y_col], color=clr, linestyle=ls, linewidth=lw, alpha=alpha, zorder=z_ord)
                else:
                    ax.plot(group['X'], group[y_col], color=clr, linestyle=ls, linewidth=lw, alpha=alpha, zorder=10)

        # 2.2 Experimental/Residual Layer
        exp_df = df[df['Type'] == 'Experimental']
        exp_handles = []
        if req.type == 'DRIVING_FORCE':
            if not exp_df.empty:
                marker_cycle = ['o', 's', '^', 'D', 'p', 'v', '<', '>', '*', 'h']
                sm = plt.cm.ScalarMappable(cmap="viridis"); sm.set_array(exp_df['Value'])
                for idx, (src_label, group) in enumerate(exp_df.groupby('Source', sort=False)):
                    marker_shape = marker_cycle[idx % len(marker_cycle)]; y_pos = model_to_y.get(src_label, 0.0)
                    if is_3d:
                        ax.scatter(group['X'], np.full_like(group['X'], y_pos), group['T'], 
                                   c=group['Value'], cmap="viridis", marker=marker_shape, 
                                   edgecolors='black', linewidths=0.4, s=60, zorder=100, 
                                   alpha=0.9, depthshade=True)
                    exp_handles.append(mlines.Line2D([], [], color='white', marker=marker_shape, linestyle='None', 
                                                   markersize=7, markeredgecolor='black', markerfacecolor='#444444', 
                                                   label=f"{src_label.replace('Archive: ', '').replace('.tdb', '')}"))
                cbar = fig.colorbar(sm, ax=ax, pad=0.1, aspect=40, shrink=0.65)
                cbar.set_label(r"Residual Driving Force $\Delta G$ (J/mol)", fontsize=12, labelpad=15, fontfamily='serif')
                cbar.ax.tick_params(labelsize=10)
        else:
            for src, group in exp_df.groupby('Source'):
                marker = group['Marker'].iloc[0] if 'Marker' in group.columns else 'o'
                for ph, ph_group in group.groupby('Phase'):
                    clr = phase_color_map.get(str(ph).upper().strip(), 'black')
                    y_col = 'T' if req.type == 'PD' else 'Value'
                    ax.scatter(ph_group['X'], ph_group[y_col], marker=marker, s=95, c=[clr], edgecolors='black', linewidths=1.2, alpha=1.0, zorder=100)
                exp_handles.append(mlines.Line2D([], [], color='white', marker=marker, linestyle='None', markersize=10, markeredgecolor='black', markerfacecolor='gray', markeredgewidth=1.2, label=f"Exp: {src}"))

        # 2.3 Meta Styling
        x_label_el = (req.config.get('target_comp') or (el_names[1] if len(el_names) > 1 else el_names[0])).upper()
        
        if is_3d:
            ax.set_xlabel(r"Mole Fraction $x_{\mathrm{" + x_label_el.capitalize() + r"}}$", fontsize=12)
            ax.set_zlabel(r"Temperature $T$ (K)", fontsize=12)
            
            # Remove Y-Axis title as per previous request
            ax.set_ylabel('')
            ax.yaxis.set_rotate_label(False)

            # Simplified tick labels
            simplified_labels = [l.replace('Archive: ', 'Archive ').replace('.tdb', '') for l in unique_ordered]
            ax.yaxis.set_major_locator(mticker.FixedLocator(np.arange(num_models)))
            ax.set_yticklabels(simplified_labels, fontsize=10, rotation=-30, ha='right', va='center', fontfamily='serif')
            
            ax.tick_params(axis='x', labelsize=10)
            ax.tick_params(axis='z', labelsize=10)
            
            # Consistent view
            ax.view_init(elev=20, azim=-60)
        else:
            ax.set_xlabel(r"Mole Fraction $x_{\mathrm{" + x_label_el.capitalize() + r"}}$", labelpad=15, fontsize=16)
            ax.set_ylabel("Temperature $T$ (K)" if req.type == 'PD' else r"Property Magnitude $\Psi$")

        if req.type in ['PD', 'DRIVING_FORCE']:
            ax.set_xlim(0, 1)
            if is_3d:
                ax.set_zlim(float(req.config.get('t_min', 300)), float(req.config.get('t_max', 2000)))
                ax.set_ylim(-0.5, float(num_models) - 0.5)
            else:
                ax.set_ylim(float(req.config.get('t_min', 300)), float(req.config.get('t_max', 2000)))
        
        if req.type == 'DRIVING_FORCE':
            bg_handle = mlines.Line2D([], [], color='#000000', label="Equilibrium Boundaries", linewidth=1.2, alpha=0.5, linestyle='--')
            leg = ax.legend(handles=[bg_handle] + exp_handles, loc='upper left', bbox_to_anchor=(1.25, 1.0), prop={'family': 'serif', 'size': 9})
            leg.get_frame().set_linewidth(0.8)
            leg.get_frame().set_edgecolor('black')
        else:
            model_handles = []
            calc_sources = df[df['Type'] == 'Calculated']['Source'].unique()
            linestyles_ref = ['-', '--', ':', '-.']
            for idx, src_label in enumerate(calc_sources):
                ls_pattern = linestyles_ref[idx % len(linestyles_ref)]
                model_handles.append(mlines.Line2D([], [], color='gray', linestyle=ls_pattern, linewidth=2, label=f"Model: {src_label}"))
            if req.type in ['ACR', 'HM_MIX']:
                final_handles = model_handles + exp_handles
            else:
                final_handles = phase_legend_handles + model_handles + exp_handles
            leg = ax.legend(handles=final_handles, loc='center left', bbox_to_anchor=(1.05, 0.5))
            leg.get_frame().set_linewidth(1.5)

        # 3. Performance Metrics Calculation (RMSE/Variance)
        performance_metrics = {}
        if not exp_df.empty and not plot_df.empty:
            for src_label in unique_ordered:
                src_calc = plot_df[plot_df['Source'] == src_label]
                if src_calc.empty: continue
                
                errors = []
                if req.type == 'DRIVING_FORCE':
                    # For driving force, the 'Value' in Experimental is already the residual
                    src_exp = exp_df[exp_df['Source'] == src_label]
                    if not src_exp.empty:
                        errors = src_exp['Value'].values
                elif req.type in ['ACR', 'HM_MIX']:
                    # Interpolate calculated values at experimental X points
                    from scipy.interpolate import interp1d
                    try:
                        f_interp = interp1d(src_calc['X'], src_calc['Value'], bounds_error=False, fill_value="extrapolate")
                        src_exp = exp_df # Experimental data is shared across models for these types
                        if not src_exp.empty:
                            calc_at_exp = f_interp(src_exp['X'])
                            errors = src_exp['Value'].values - calc_at_exp
                    except: pass
                
                if len(errors) > 0:
                    rmse = np.sqrt(np.mean(np.square(errors)))
                    variance = np.var(errors)
                    performance_metrics[src_label] = {
                        "rmse": float(rmse),
                        "variance": float(variance),
                        "count": int(len(errors))
                    }

        buf = io.BytesIO()
        plt.savefig(buf, format='png', dpi=240, bbox_inches='tight', pad_inches=0.4, transparent=False)
        plt.close(fig)
        return {
            "status": "success", 
            "image": base64.b64encode(buf.getvalue()).decode('utf-8'), 
            "csv_data": df.to_csv(index=False),
            "performance_metrics": performance_metrics,
            "diagnostics": "\n".join(diag_logs)
        }
    except Exception as e:
        return {
            "status": "error", 
            "message": str(e), 
            "trace": traceback.format_exc(), 
            "diagnostics": "\n".join(diag_logs)
        }
