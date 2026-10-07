
import uvicorn, io, base64, logging, traceback, json, numpy as np, matplotlib, os, sys, warnings
# 1. Force system-level warning suppression
warnings.filterwarnings("ignore")
os.environ['PYTHONWARNINGS'] = 'ignore'

matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.lines as mlines
import tinydb
import pandas as pd
from tinydb.storages import MemoryStorage
from fastapi import APIRouter
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
from collections import OrderedDict
import re

# ESPEI & PyCalphad Expert Stack
from espei import generate_parameters
from pycalphad import Database, equilibrium, binplot, calculate, variables as v
from espei.utils import bib_marker_map
from pycalphad.plot.utils import phase_legend

router = APIRouter()

R = 8.3145

class FittingRequest(BaseModel):
    phase_model: Dict[str, Any]
    datasets: List[Dict[str, Any]]
    config: Dict[str, Any]

def _apply_arctde_style(ax):
    """Apply upgraded academic plotting style V11.3: remove top and right axis ticks, unify fonts and linewidths"""
    plt.rcParams.update({
        'font.family': 'serif',
        'font.serif': ['Times New Roman', 'DejaVu Serif'],
        'mathtext.fontset': 'stix',
        'axes.linewidth': 2.0,
        'xtick.direction': 'in',
        'ytick.direction': 'in',
        'xtick.top': False,
        'ytick.right': False,
        'xtick.major.size': 8,
        'ytick.major.size': 8,
        'xtick.major.width': 1.5,
        'ytick.major.width': 1.5,
        'xtick.labelsize': 12,
        'ytick.labelsize': 12,
        'axes.labelsize': 14,
        'legend.fontsize': 10,
        'legend.frameon': True,
        'legend.edgecolor': 'black',
        'legend.fancybox': False,
        'axes.titlesize': 16,
        'axes.titleweight': 'bold',
        'axes.labelpad': 10
    })
    ax.tick_params(top=False, right=False, which='both')
    ax.set_box_aspect(1)
    ax.grid(False)

def normalize_dataset(ds):
    if not isinstance(ds, dict): return ds
    if 'components' in ds:
        ds['components'] = [str(c).upper() for c in ds['components']]
    if 'phases' in ds:
        ds['phases'] = [str(p).strip().upper() for p in ds['phases']]
    if 'conditions' in ds:
        new_conds = {}
        for k, val in ds['conditions'].items():
            key = str(k).upper()
            new_conds[key] = val
        ds['conditions'] = new_conds
    if 'output' in ds:
        ds['output'] = str(ds['output']).upper()
    if 'solver' in ds and isinstance(ds['solver'], dict):
        if 'sublattice_configurations' in ds['solver']:
            new_configs = []
            for config in ds['solver']['sublattice_configurations']:
                new_config = []
                for subl in config:
                    if isinstance(subl, list):
                        new_config.append([str(c).upper() for c in subl])
                    elif isinstance(subl, str):
                        new_config.append(str(subl).upper())
                    else:
                        new_config.append(subl)
                new_configs.append(new_config)
            ds['solver']['sublattice_configurations'] = new_configs
            
    if 'values' in ds and ds.get('output', '').upper() == 'ZPF':
        new_values = []
        for point in ds['values']:
            new_point = []
            for phase_region in point:
                if len(phase_region) == 3:
                    p_name, p_comps, p_vals = phase_region
                    new_point.append([
                        str(p_name).strip().upper(),
                        [str(c).upper() for c in p_comps] if isinstance(p_comps, list) else p_comps,
                        p_vals
                    ])
                else:
                    new_point.append(phase_region)
            new_values.append(new_point)
        ds['values'] = new_values

    return ds

@router.post("/run-espei")
async def run_fitting(req: FittingRequest):
    """Deep log interception: shield noise and recover TRACE/DEBUG level traces"""
    log_stream = io.StringIO()
    handler = logging.StreamHandler(log_stream)
    handler.setFormatter(logging.Formatter('%(message)s'))
    
    # Recursively take over all relevant Loggers and set to DEBUG level to capture TRACE details
    target_loggers = ['espei', 'pycalphad']
    # Also get all registered sub-loggers
    sub_loggers = [name for name in logging.root.manager.loggerDict if any(name.startswith(t) for t in target_loggers)]
    
    for name in set(target_loggers + sub_loggers):
        l = logging.getLogger(name)
        l.setLevel(logging.DEBUG) 
        while l.handlers: l.removeHandler(l.handlers[0])
        l.addHandler(handler)
        l.propagate = False

    try:
        db_mem = tinydb.TinyDB(storage=MemoryStorage)
        for ds in req.datasets:
            db_mem.insert(normalize_dataset(ds))
        
        conf = req.config
        
        if conf.get('use_tags', False):
            for ds in db_mem.all():
                d_tags = ds.get('tags', [])
                updated = False
                if 'estimated-entropy' in d_tags:
                    if 'weight' not in ds: 
                        ds['weight'] = 0.1
                        updated = True
                    if 'excluded_model_contributions' not in ds:
                        ds['excluded_model_contributions'] = ['idmix', 'mag']
                        updated = True
                if 'dft' in d_tags:
                    if 'excluded_model_contributions' not in ds:
                        ds['excluded_model_contributions'] = ['idmix', 'mag']
                        updated = True
                if updated:
                    db_mem.update(ds, doc_ids=[ds.doc_id])
        # Fix keyword argument: refdata -> ref_state to adapt to ESPEI 0.9.0+
        pm = req.phase_model
        if "components" in pm:
            pm["components"] = [str(c).upper() for c in pm["components"]]
        if "phases" in pm:
            new_phases = {}
            for ph_name, ph_data in pm["phases"].items():
                if "sublattice_model" in ph_data:
                    ph_data["sublattice_model"] = [[str(c).upper() for c in subl] for subl in ph_data["sublattice_model"]]
                new_phases[str(ph_name).strip().upper()] = ph_data
            pm["phases"] = new_phases

        aicc_penalty = conf.get('aicc_penalty_factor')
        if not aicc_penalty:
            aicc_penalty = None

        dbf = generate_parameters(
            pm, 
            db_mem, 
            ref_state=conf.get('ref_state', 'SGTE91'),
            excess_model=conf.get('excess_model', 'linear'),
            aicc_penalty_factor=aicc_penalty
        )
        
        # Capture and perform rigorous noise filtering
        raw_log = log_stream.getvalue()
        clean_log_lines = []
        noise_keywords = ["UserWarning", "deprecated", "pkg_resources", "FutureWarning", "PendingDeprecationWarning"]
        
        for line in raw_log.split('\n'):
            if not any(k in line for k in noise_keywords) and line.strip():
                clean_log_lines.append(line)
        
        return {
            "status": "success", 
            "tdb": dbf.to_string(fmt='tdb'), 
            "log": "\n".join(clean_log_lines)
        }
    except Exception as e:
        return {"status": "error", "message": str(e), "log": log_stream.getvalue()}
    finally:
        handler.close()

@router.post("/plot-property")
async def plot_property(data: dict):
    diag_logs = []
    try:
        plt.clf(); plt.close('all')
        raw_tdb = data.get('tdb_content')
        if not raw_tdb: return {"status": "error", "message": "TDB content is empty"}
        tdb_str = raw_tdb.replace('\r\n', '\n').replace('\r', '\n').replace('\xa0', ' ')
        
        dbf = Database(tdb_str)
        el_names = sorted([str(e).upper() for e in dbf.elements if str(e).upper() != 'VA'])
        comps_for_calc = el_names + (['VA'] if 'VA' in [str(e).upper() for e in dbf.elements] else [])
        phases = sorted(list(dbf.phases.keys()))
        
        db_mem = tinydb.TinyDB(storage=MemoryStorage)
        raw_datasets = data.get('datasets', [])
        normalized_ds = [normalize_dataset(ds) for ds in raw_datasets]
        for ds in normalized_ds: db_mem.insert(ds)
        
        p_type = data.get('type')
        fig, ax = plt.subplots(figsize=(10, 10), dpi=160)
        _apply_arctde_style(ax)

        calc_handles, phase_color_map = phase_legend(phases)
        csv_records = []

        t_step = float(data.get('t_step', 10))

        # ---------------------------------------------------------
        # 1. Phase Diagram (PD)
        # ---------------------------------------------------------
        if p_type == 'PD':
            x_el = el_names[1] if len(el_names) > 1 else el_names[0]
            t_min, t_max = float(data.get('t_min', 300)), float(data.get('t_max', 2000))
            conds = {v.P: 101325, v.T: (t_min, t_max, t_step), v.X(x_el): (0, 1, 0.02)}
            ax = binplot(dbf, comps_for_calc, phases, conds, ax=ax, zorder=0, legend=False)
            
            # Extract calculated phase boundary data
            for line in ax.get_lines():
                line_x = line.get_xdata()
                line_y = line.get_ydata()
                label = line.get_label() or "Phase Boundary"
                for lx, ly in zip(line_x, line_y):
                    csv_records.append({
                        "Data_Type": "Calculated",
                        "Temperature_K": ly,
                        f"X_{x_el}": lx,
                        "Label_or_Phase": label,
                        "Reference_Source": "This Work (ESPEI Calculation)"
                    })

            desired_data = db_mem.search(tinydb.where('output') == 'ZPF')
            bib_keys = sorted({entry.get('reference', 'Unknown') for entry in desired_data})
            symbol_map = bib_marker_map(bib_keys)
            
            final_handles = list(calc_handles); final_labels = list(phases)
            
            for ds in desired_data:
                ref = ds.get('reference', 'Unknown')
                marker_info = symbol_map.get(ref, {'markers': {'marker': 'o'}})
                for i, point in enumerate(ds.get('values', [])):
                    temp = ds['conditions']['T'][i] if isinstance(ds['conditions']['T'], list) else ds['conditions']['T']
                    if temp < 273.15 and t_min > 273.15: temp += 273.15
                    for p_name, p_comps, p_vals in point:
                        if x_el in p_comps:
                            xv = p_vals[p_comps.index(x_el)]
                            if xv is not None:
                                ax.scatter(xv, temp, marker=marker_info['markers']['marker'], s=40, 
                                           c=phase_color_map.get(p_name, '#000000'), edgecolors='black', 
                                           linewidths=1.0, zorder=100)
                                csv_records.append({
                                    "Data_Type": "Experimental",
                                    "Temperature_K": temp,
                                    f"X_{x_el}": xv,
                                    "Label_or_Phase": p_name,
                                    "Reference_Source": ref
                                })
                
                exp_handle = mlines.Line2D([], [], color='white', marker=marker_info['markers']['marker'], linestyle='None', markersize=6, markeredgecolor='black', label=f"Ref: {ref}")
                if f"Ref: {ref}" not in final_labels: final_handles.append(exp_handle); final_labels.append(f"Ref: {ref}")
            
            ax.set_title(f"{'-'.join(el_names)} Phase Diagram", pad=25)
            ax.set_xlabel(f"Mole Fraction $X_{{\\mathrm{{{x_el.capitalize()}}}}}$")
            ax.set_ylabel("Temperature (K)")

        # ---------------------------------------------------------
        # 2. Activity (ACR)
        # ---------------------------------------------------------
        elif p_type == 'ACR':
            target_el = (data.get('target_comp') or el_names[1]).upper()
            other_el = [e for e in el_names if e != target_el][0] if len(el_names) > 1 else None
            temp = float(data.get('temperature', 1000))
            target_phase = (data.get('phase') or 'LIQUID').upper()
            
            res_pure = equilibrium(dbf, comps_for_calc, [target_phase], {v.P: 101325, v.T: temp, v.X(target_el): 1-1e-9})
            mu_pure = float(res_pure.MU.sel(component=target_el).values.flatten()[0])
            
            x_range = np.linspace(0.0, 1.0, 101)
            res = equilibrium(dbf, comps_for_calc, [target_phase], {v.P: 101325, v.T: temp, v.X(target_el): x_range})
            calc_x = res.X.sel(component=target_el, vertex=0).squeeze().values
            mu_vals = res.MU.sel(component=target_el).squeeze().values
            activity = np.exp((mu_vals - mu_pure) / (R * temp))
            
            ax.plot([0, 1], [0, 1], color='gray', linestyle='--', alpha=0.5, label='Ideal')
            ax.plot(calc_x, activity, color='black', linewidth=3.0, label=f'Model ({target_phase})', zorder=5)
            
            for cx, cy in zip(calc_x, activity):
                csv_records.append({
                    "Data_Type": "Calculated",
                    f"X_{target_el}": cx,
                    f"Activity_{target_el}": cy,
                    "Source": "This Work (ESPEI)",
                    "Temperature_K": temp
                })

            exp_matches = db_mem.search(
                (tinydb.where('output').test(lambda x: bool(re.search(r'ACR|ACTIVITY', str(x), re.IGNORECASE)))) &
                (tinydb.where('components').test(lambda x: target_el in x))
            )
            bib_keys = sorted({entry.get('reference', 'Unknown') for entry in exp_matches})
            symbol_map = bib_marker_map(bib_keys)
            color_cycle = plt.cm.Dark2.colors
            ref_color_map = {ref: color_cycle[i % len(color_cycle)] for i, ref in enumerate(bib_keys)}
            
            final_handles = [mlines.Line2D([], [], color='black', linewidth=3.0, label=f'Model ({target_phase})')]
            final_labels = [f'Model ({target_phase})']
            
            for ds in exp_matches:
                ref = ds.get('reference', 'Unknown')
                marker_info = symbol_map.get(ref, {'markers': {'marker': 'o'}})
                r_color = ref_color_map[ref]
                conds_ds = ds['conditions']
                ex = None
                ex_raw = conds_ds.get(f'X_{target_el}') or conds_ds.get(f'X({target_el})') or conds_ds.get(target_el)
                if ex_raw is not None: ex = np.array(ex_raw).flatten()
                elif other_el:
                    ex_other = conds_ds.get(f'X_{other_el}') or conds_ds.get(f'X({other_el})') or conds_ds.get(other_el)
                    if ex_other is not None: ex = 1.0 - np.array(ex_other).flatten()
                if ex is None: continue
                ey = np.array(ds['values']).flatten()
                ax.scatter(ex, ey, marker=marker_info['markers']['marker'], s=40, c=[r_color], edgecolors='black', linewidths=1.0, zorder=10)
                
                exp_t = conds_ds.get('T', temp)
                for x_val, y_val in zip(ex, ey):
                    csv_records.append({
                        "Data_Type": "Experimental",
                        f"X_{target_el}": x_val,
                        f"Activity_{target_el}": y_val,
                        "Source": ref,
                        "Temperature_K": exp_t
                    })

                exp_handle = mlines.Line2D([], [], color=r_color, marker=marker_info['markers']['marker'], linestyle='None', markersize=6, markeredgecolor='black', label=f"Ref: {ref}")
                if f"Ref: {ref}" not in final_labels: final_handles.append(exp_handle); final_labels.append(f"Ref: {ref}")

            ax.set_title(f"Activity of {target_el} in {target_phase}", pad=25)
            ax.set_xlabel(f"Mole Fraction $X_{{\\mathrm{{{target_el.capitalize()}}}}}$")
            ax.set_ylabel(f"Activity $a_{{\\mathrm{{{target_el.capitalize()}}}}}$")
            ax.set_xlim(0, 1); ax.set_ylim(0, 1)

        # ---------------------------------------------------------
        # 3. Mixing Enthalpy (HM_MIX)
        # ---------------------------------------------------------
        elif p_type == 'HM_MIX':
            target_phase = (data.get('phase') or 'LIQUID').upper()
            temp = float(data.get('temperature', 1000))
            x_el = (data.get('target_comp') or el_names[1]).upper()
            other_el = [e for e in el_names if e != x_el][0] if len(el_names) > 1 else None
            
            calc_x_grid = np.linspace(0, 1, 101)
            calc_y_vals = []
            for val in calc_x_grid:
                sample = calculate(dbf, comps_for_calc, target_phase, T=temp, P=101325, 
                                   points=np.array([[1-val, val]]), output='HM_MIX')
                y_val = float(sample.HM_MIX.values.flatten()[0])
                calc_y_vals.append(y_val)
                csv_records.append({
                    "Data_Type": "Calculated",
                    f"X_{x_el}": val,
                    "HM_MIX_J_mol": y_val,
                    "Source": "ESPEI"
                })
            
            ax.plot(calc_x_grid, calc_y_vals, color='black', linewidth=3.0, label='Model Calculation', zorder=5)
            ax.axhline(0, color='gray', linestyle='--', linewidth=1.5, alpha=0.6)

            exp_matches = db_mem.search(
                (tinydb.where('output').test(lambda x: bool(re.search(r'HM_MIX|HM_FORM', str(x), re.IGNORECASE)))) &
                (tinydb.where('phases').test(lambda x: target_phase in x))
            )
            bib_keys = sorted({entry.get('reference', 'Unknown') for entry in exp_matches})
            symbol_map = bib_marker_map(bib_keys)
            color_cycle = plt.cm.Dark2.colors
            ref_color_map = {ref: color_cycle[i % len(color_cycle)] for i, ref in enumerate(bib_keys)}
            
            final_handles = [mlines.Line2D([], [], color='black', linewidth=3.0, label='Model Calculation')]
            final_labels = ['Model Calculation']

            for ds in exp_matches:
                ref = ds.get('reference', 'Unknown')
                conds_ds = ds['conditions']
                ex = None
                ex_raw = conds_ds.get(f'X_{x_el}') or conds_ds.get(f'X({x_el})') or conds_ds.get(x_el)
                if ex_raw is None and 'solver' in ds:
                    try:
                        solver = ds['solver']
                        config_template = solver['sublattice_configurations'][0]
                        found_idx = -1
                        for subl_idx, subl_els in enumerate(config_template):
                            if isinstance(subl_els, list) and x_el in subl_els:
                                found_idx = subl_els.index(x_el)
                                break
                        if found_idx != -1:
                            occupancies = np.array(solver['sublattice_occupancies'])
                            ex = occupancies[:, 0, found_idx].flatten()
                    except: pass

                if ex is None and ex_raw is not None: ex = np.array(ex_raw).flatten()
                elif ex is None and other_el:
                    ex_other = conds_ds.get(f'X_{other_el}') or conds_ds.get(f'X({other_el})') or conds_ds.get(other_el)
                    if ex_other is not None: ex = 1.0 - np.array(ex_other).flatten()
                
                if ex is None: continue
                ey = np.array(ds['values']).flatten()
                r_color = ref_color_map[ref]
                marker_info = symbol_map.get(ref, {'markers': {'marker': 'o'}})
                ax.scatter(ex, ey, marker=marker_info['markers']['marker'], s=40, c=[r_color], edgecolors='black', linewidths=1.0, zorder=10)
                
                for x_val, y_val in zip(ex, ey):
                    csv_records.append({
                        "Data_Type": "Experimental",
                        f"X_{x_el}": x_val,
                        "HM_MIX_J_mol": y_val,
                        "Source": ref
                    })

                exp_handle = mlines.Line2D([], [], color=r_color, marker=marker_info['markers']['marker'], linestyle='None', markersize=6, markeredgecolor='black', label=f"Ref: {ref}")
                if f"Ref: {ref}" not in final_labels: final_handles.append(exp_handle); final_labels.append(f"Ref: {ref}")

            ax.set_title(f"Mixing Enthalpy of {target_phase}", pad=25)
            ax.set_xlabel(f"Mole Fraction $X_{{\\mathrm{{{x_el.capitalize()}}}}}$")
            ax.set_ylabel("Mixing Enthalpy (J/mol)")
            ax.set_xlim(0, 1)

        # ---------------------------------------------------------
        # 4. Driving Force (DRIVING_FORCE)
        # ---------------------------------------------------------
        elif p_type == 'DRIVING_FORCE':
            diag_logs.append("[DRIVING_FORCE] Executing alignment diagnostics...")
            x_el = (data.get('target_comp') or (el_names[1] if len(el_names) > 1 else el_names[0])).upper()
            t_min, t_max = float(data.get('t_min', 30)), float(data.get('t_max', 2000))
            indep_comp_cond = v.X(x_el)
            
            try:
                conds_pd = {v.N: 1, v.P: 101325, v.T: (t_min, t_max, t_step), indep_comp_cond: (0, 1, 0.01)}
                ax = binplot(dbf, comps_for_calc, phases, conds_pd, ax=ax, zorder=0, legend=False)
                for line in ax.get_lines():
                    line.set_alpha(0.12); line.set_color('gray'); line.set_linewidth(1.0); line.set_label(None)
                if ax.get_legend(): ax.get_legend().remove()
            except Exception as e:
                diag_logs.append(f"[DRIVING_FORCE] Background rendering exception: {str(e)}")

            full_comps = sorted(comps_for_calc)
            parameters = {}
            try:
                zpf_db = tinydb.TinyDB(storage=MemoryStorage)
                zpf_found = 0
                for ds in normalized_ds:
                    if ds.get('output') == 'ZPF':
                        ds_copy = json.loads(json.dumps(ds))
                        conds = ds_copy.get('conditions', {})
                        broadcast = ds_copy.get('broadcast_conditions', True)
                        num_values = len(ds_copy.get('values', []))
                        for k in ['T', 'P']:
                            if k in conds:
                                val = conds[k]
                                is_list = isinstance(val, (list, np.ndarray))
                                if not broadcast:
                                    if not is_list: conds[k] = [float(val)] * num_values
                                    else: conds[k] = [float(x) for x in val]
                                else:
                                    if is_list: conds[k] = float(np.array(val).flatten()[0])
                                    else: conds[k] = float(val)
                        zpf_db.insert(ds_copy)
                        zpf_found += 1
                
                if zpf_found > 0:
                    from espei.error_functions.zpf_error import get_zpf_data, calculate_zpf_driving_forces
                    from pycalphad.core.utils import extract_parameters
                    zpf_data = get_zpf_data(dbf, full_comps, phases, zpf_db, parameters=parameters)
                    param_vec = extract_parameters(parameters)[1]
                    driving_forces, weights = calculate_zpf_driving_forces(zpf_data, param_vec)
                    
                    Xs, Ts, dfs = [], [], []
                    for data_entry, data_driving_forces in zip(zpf_data, driving_forces):
                        driving_force_offset = 0
                        for phase_region in data_entry["phase_regions"]:
                            for vertex, df in zip(phase_region.vertices, data_driving_forces[driving_force_offset:]):
                                driving_force_offset += 1
                                if vertex.has_missing_comp_cond: continue
                                temp = float(phase_region.potential_conds[v.T])
                                if temp < 273.15 and t_min > 273.15: temp += 273.15
                                comp_cond = vertex.comp_conds
                                if indep_comp_cond in comp_cond: x_val = float(comp_cond[indep_comp_cond])
                                else:
                                    try: x_val = 1.0 - float(list(comp_cond.values())[0])
                                    except: continue
                                Xs.append(x_val); Ts.append(temp); dfs.append(float(df))
                                csv_records.append({
                                    f"X_{x_el}": x_val,
                                    "Temperature_K": temp,
                                    "Driving_Force_J_mol": float(df)
                                })
                    
                    if Xs:
                        sm = plt.cm.ScalarMappable(cmap="coolwarm")
                        sm.set_array(dfs)
                        ax.scatter(Xs, Ts, c=dfs, cmap="coolwarm", edgecolors="black", 
                                  linewidths=0.8, s=40, alpha=1.0, zorder=100)
                        
                        cbar = fig.colorbar(sm, ax=ax, pad=0.03, aspect=20)
                        cbar.set_label("Driving Forces", fontsize=13, labelpad=15)
                        cbar.ax.tick_params(labelsize=10)
                        diag_logs.append(f"[DRIVING_FORCE] Successfully mapped {len(Xs)}  vertices.")
            except Exception as e:
                diag_logs.append(f"[DRIVING_FORCE ERROR] Kernel fault: {str(e)}")

            ax.set_title(f"{'-'.join(el_names)} Forces", pad=25)
            ax.set_xlabel(f"Mole Fraction $X_{{\\mathrm{{{x_el.capitalize()}}}}}$")
            ax.set_ylabel("Temperature (K)")
            ax.set_xlim(0, 1); ax.set_ylim(t_min, t_max)

        if 'final_handles' in locals() and p_type != 'DRIVING_FORCE':
            ax.legend(final_handles, final_labels, loc='center left', bbox_to_anchor=(1.05, 0.5), 
                      borderaxespad=0., handletextpad=0.5)

        fig.canvas.draw()
        buf = io.BytesIO()
        plt.savefig(buf, format='png', dpi=160, bbox_inches='tight', facecolor='white')
        plt.close(fig)
        
        # Convert records to CSV string
        final_csv = ""
        if csv_records:
            df_out = pd.DataFrame(csv_records)
            final_csv = df_out.to_csv(index=False)

        return {
            "status": "success", 
            "image": base64.b64encode(buf.getvalue()).decode('utf-8'), 
            "csv_data": final_csv,
            "diagnostics": "\n".join(diag_logs)
        }
    except Exception as e:
        return {"status": "error", "message": str(e), "detail": traceback.format_exc(), "diagnostics": "\n".join(diag_logs)}
