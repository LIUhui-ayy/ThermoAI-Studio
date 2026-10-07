
import os
import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
import time
import warnings
import numpy as np
import optuna
import logging
import sqlite3
import traceback
import dask
import re
import gc
from pycalphad import Database, equilibrium, calculate, variables as v
from espei.datasets import load_datasets, recursive_glob
from espei.error_functions.context import setup_context
from dask.distributed import Client, LocalCluster
from tinydb import TinyDB
from tinydb.storages import MemoryStorage

sys.setrecursionlimit(10000)
warnings.filterwarnings("ignore")

dask.config.set({
    'distributed.comm.timeouts.connect': '120s',
    'distributed.comm.timeouts.tcp': '120s',
    'distributed.comm.timeouts.shutdown': '600s',
    'distributed.worker.memory.target': False,  
    'distributed.worker.memory.spill': False,  
    'distributed.worker.memory.pause': False,   
    'distributed.worker.memory.terminate': False,
})

from espei.error_functions import zpf_error
def robust_extract_pot_conds(conditions, index):
    pot_conds = {}
    for cond_key, cond_val in conditions.items():
        if cond_key not in ['T', 'P']: continue
        try:
            arr = np.atleast_1d(cond_val)
            val = arr[index] if len(arr) > index else arr[0]
            pot_conds[getattr(v, cond_key)] = float(val)
        except: continue
    return pot_conds
zpf_error._extract_pot_conds = robust_extract_pot_conds

LOG_FILE = "A25-CU-MG_Optimization_Final.log"

def setup_logging():
    for handler in logging.root.handlers[:]:
        logging.root.removeHandler(handler)
    file_handler = logging.FileHandler(LOG_FILE, mode='a', encoding='utf-8')
    file_format = logging.Formatter("%(asctime)s [%(process)d] %(message)s")
    file_handler.setFormatter(file_format)
    logger = logging.getLogger("Optimizer")
    logger.setLevel(logging.INFO)
    logger.addHandler(file_handler)
    optuna.logging.set_verbosity(optuna.logging.ERROR)
    return logger

def evaluate_residual(res_obj, params):
    params_array = np.array(params, dtype=float)
    for m in ['get_likelihood', 'compute', 'probability', 'calculate']:
        if hasattr(res_obj, m): return getattr(res_obj, m)(params_array)
    return res_obj(params_array) if hasattr(res_obj, '__call__') else 0.0

_WORKER_CACHE = {}

def get_worker_state(tdb_path, data_path):
    global _WORKER_CACHE
    if 'initialized' not in _WORKER_CACHE:
        dbf = Database(tdb_path)
        all_ds = load_datasets(recursive_glob(data_path, '*.json'))
        symbols_to_fit = sorted([sym for sym in dbf.symbols.keys() if sym.startswith('V')])
        initial_values = [float(dbf.symbols[s].subs({v.T: 298.15})) if hasattr(dbf.symbols[s], 'subs') else float(dbf.symbols[s]) for s in symbols_to_fit]
        
        zpf_datasets = [ds for ds in all_ds if str(ds.get('output', '')).upper() == "ZPF"]
        thermo_ds = [ds for ds in all_ds if str(ds.get('output', '')).upper() != "ZPF"]

        groups = {}
        for ds in thermo_ds:
            prop = str(ds.get('output', '')).upper()
            tags = [t.lower() for t in ds.get('tags', [])]
            source = "DFT" if 'dft' in tags else ("EST" if 'est' in tags else "EXP")
            
            if any(k in prop for k in ["ACR", "ACTIVITY"]): p_type = "ACR"
            elif "HM" in prop: p_type = "HM"
            elif "SM" in prop: p_type = "SM"
            elif "CPM" in prop: p_type = "CPM"
            else: p_type = prop
            
            groups.setdefault((p_type, source), []).append(ds)

        contexts = {}
        for meta, ds_list in groups.items():
            idx = TinyDB(storage=MemoryStorage); idx.insert_multiple(ds_list)
            ctx = setup_context(dbf, idx, symbols_to_fit)
            res_objs = ctx.get('residual_objs') or ctx.get('residuals')
            if res_objs: contexts[meta] = res_objs

        base_scores = {k: sum(evaluate_residual(r, initial_values) for r in objs) for k, objs in contexts.items()}

        _WORKER_CACHE.update({
            'dbf': dbf, 'symbols_to_fit': symbols_to_fit, 'contexts': contexts,
            'base_scores': base_scores, 'zpf_datasets': zpf_datasets, 
            'initial_values': initial_values, 'initialized': True
        })
    return _WORKER_CACHE

def calculate_driving_force_zpf(dbf, zpf_ds, params_dict):
    for s, v_val in params_dict.items():
        dbf.symbols[s] = float(v_val)

    comps = sorted(dbf.elements)
    all_phases = sorted(dbf.phases.keys())
    
    error_list = [] 
    global_crash_penalty = 0.0 
    missing_count = 0

    score_exist = 0.0
    score_missing = 0.0
    score_extra = 0.0
    score_A = 0.0
    score_C = 0.0
    score_D = 0.0
    detail_logs = []
    
    # Custom Axis Component setting
    AXIS_COMP = "MG"

    for ds in zpf_ds:
        w = ds.get('weight', 1.0)
        conds = ds.get('conditions', {})
        t_vals = np.atleast_1d(conds.get('T', 298.15))
        p_vals = np.atleast_1d(conds.get('P', 101325))
        
        values = ds.get('values', [])
        for i, val_row in enumerate(values):
            T = float(t_vals[i] if i < len(t_vals) else t_vals[-1])
            P = float(p_vals[i] if i < len(p_vals) else p_vals[-1])
            steep_weight = 1
            target_phases = []
            exp_comps = {}
            
            for phase_rec in val_row:
                p_name = phase_rec[0]
                if p_name not in target_phases:
                    target_phases.append(p_name)
                if len(phase_rec) > 2:
                    c_names = phase_rec[1]
                    c_vals = phase_rec[2]
                    for c_idx, c_name in enumerate(c_names):
                        if c_vals[c_idx] is not None and c_name == AXIS_COMP:
                            exp_comps[p_name] = float(c_vals[c_idx])
            
            if not target_phases: continue
            
            x_probes = []
            if len(exp_comps) >= 2:
                x_probes = [sum(exp_comps.values()) / len(exp_comps)]
            elif len(exp_comps) == 1:
                p1 = list(exp_comps.keys())[0]
                x_e = exp_comps[p1]
                x_probes = [min(x_e + 0.03, 0.99), max(x_e - 0.03, 0.01)]
            else:
                x_probes = [0.5]

            eq_local = None
            for x_safe in x_probes:
                eq_cond = {v.T: T, v.P: P, v.X(AXIS_COMP): x_safe}
                try:
                    temp_eq = equilibrium(dbf, comps, target_phases, eq_cond)
                    found_phases = set(temp_eq.Phase.values.flatten()) - {''}
                    if len(found_phases) >= 2:
                        eq_local = temp_eq
                        break 
                    elif eq_local is None:
                        eq_local = temp_eq 
                except: pass
                
            if eq_local is None:
                pen = 1e6 * w * steep_weight
                global_crash_penalty += pen
                score_missing += pen
                detail_logs.append(f"[异常] 平衡计算失败 (eq is None) | T={T:6.1f} | 惩罚={pen:>10.2f}")
                continue
            
            try:
                phase_array = eq_local.Phase.values.flatten()
                
                mu_dict = {}
                try:
                    mu_dict = {str(c): float(eq_local.MU.sel(component=c).values.flatten()[0]) 
                               for c in eq_local.MU.coords['component'].values}
                except: pass
                valid_mu = not any(np.isnan(val) for val in mu_dict.values())

                for p_name, x_exp in exp_comps.items():
                    idx = np.where(phase_array == p_name)[0]
                    if len(idx) > 0:
                        if valid_mu:
                            try:
                                calc_res = calculate(dbf, comps, [p_name], T=T, P=P)
                                gm_vals = calc_res.GM.values.squeeze()
                                x_vals = calc_res.X.values.squeeze()
                                if gm_vals.ndim == 0:
                                    gm_vals, x_vals = np.array([gm_vals]), np.array([x_vals])

                                g_ref_grid = np.zeros_like(gm_vals)
                                comp_coords = calc_res.coords['component'].values
                                for c_idx, comp_name in enumerate(comp_coords):
                                    comp_str = str(comp_name)
                                    if comp_str in mu_dict:
                                        g_ref_grid += x_vals[..., c_idx] * mu_dict[comp_str]
                                
                                df_array = gm_vals - g_ref_grid
                                
                                x_axis_vals = calc_res.X.sel(component=AXIS_COMP).values.squeeze()
                                if x_axis_vals.ndim == 0:
                                    x_axis_vals = np.array([x_axis_vals])
                                
                                if len(x_axis_vals) > 1:
                                    bins = np.linspace(0.0, 1.0, 501)
                                    bin_idx = np.digitize(x_axis_vals, bins)
                                    
                                    env_x, env_df = [], []
                                    for b in range(1, 502):
                                        in_bin = np.where(bin_idx == b)[0]
                                        if len(in_bin) > 0:
                                            min_idx = in_bin[np.argmin(df_array[in_bin])]
                                            env_x.append(x_axis_vals[min_idx])
                                            env_df.append(df_array[min_idx])
                                            
                                    if len(env_x) > 1:
                                        actual_df = float(np.interp(x_exp, env_x, env_df))
                                    else:
                                        actual_df = float(env_df[0])
                                else:
                                    actual_df = float(df_array[0])
                                
                                single_err = abs(actual_df) * 100.0 * w
                                error_list.append(single_err)
                                
                                score_exist += single_err
                                detail_logs.append(f"[存在] T={T:6.1f} P={P} 相={p_name:8} X_exp={x_exp:.3f} | Actual_DF={actual_df:>8.2f} J/mol | 得分={single_err:>10.2f}")
                            except:
                                pen = 50000.0 * w
                                error_list.append(pen)
                                score_exist += pen
                                detail_logs.append(f"[存在-计算异常] T={T:6.1f} 相={p_name:8} | 得分={pen:>10.2f}")
                        else:
                            pen = 50000.0 * w
                            error_list.append(pen)
                            score_exist += pen
                            detail_logs.append(f"[存在-MU异常] T={T:6.1f} 相={p_name:8} | 得分={pen:>10.2f}")
                    else:
                        missing_count += 1
                        if valid_mu:
                            try:
                                calc_res = calculate(dbf, comps, [p_name], T=T, P=P)
                                gm_vals = calc_res.GM.values.squeeze()
                                x_vals = calc_res.X.values.squeeze()
                                if gm_vals.ndim == 0:
                                    gm_vals, x_vals = np.array([gm_vals]), np.array([x_vals])

                                g_ref_grid = np.zeros_like(gm_vals)
                                comp_coords = calc_res.coords['component'].values
                                for c_idx, comp_name in enumerate(comp_coords):
                                    comp_str = str(comp_name)
                                    if comp_str in mu_dict:
                                        g_ref_grid += x_vals[..., c_idx] * mu_dict[comp_str]
                                
                                df_array = gm_vals - g_ref_grid
                                min_df = float(np.nanmin(df_array))
                                
                                if min_df > 0:
                                    phase_missing_penalty = (abs(min_df) * 100.0 + 20000.0) * w
                                    error_list.append(phase_missing_penalty)
                                    score_missing += phase_missing_penalty
                                    detail_logs.append(f"[缺相] T={T:6.1f} P={P} 相={p_name:8} X_exp={x_exp:.3f} | Min_DF={min_df:>8.2f} J/mol | 得分={phase_missing_penalty:>10.2f}")
                                else:
                                    phase_missing_penalty = 50000.0 * w
                                    error_list.append(phase_missing_penalty)
                                    score_missing += phase_missing_penalty
                                    detail_logs.append(f"[缺相-MinDF<0] T={T:6.1f} 相={p_name:8} | 得分={phase_missing_penalty:>10.2f}")
                            except:
                                phase_missing_penalty = 50000.0 * w
                                error_list.append(phase_missing_penalty)
                                score_missing += phase_missing_penalty
                                detail_logs.append(f"[缺相-计算异常] T={T:6.1f} 相={p_name:8} | 得分={phase_missing_penalty:>10.2f}")
                        else:
                            phase_missing_penalty = 50000.0 * w
                            error_list.append(phase_missing_penalty)
                            score_missing += phase_missing_penalty
                            detail_logs.append(f"[缺相-MU异常] T={T:6.1f} 相={p_name:8} | 得分={phase_missing_penalty:>10.2f}")
                            
                if not valid_mu:
                    pen = 50000.0 * w
                    global_crash_penalty += pen
                    score_missing += pen
                    detail_logs.append(f"[异常] 最外层MU缺失 | T={T:6.1f} | 惩罚={pen:>10.2f}")
                    continue

                for p_name in all_phases:
                    if p_name in target_phases: continue
                    try:
                        calc_res = calculate(dbf, comps, [p_name], T=T, P=P)
                        gm_vals = calc_res.GM.values.squeeze()
                        x_vals = calc_res.X.values.squeeze()
                        if gm_vals.ndim == 0:
                            gm_vals, x_vals = np.array([gm_vals]), np.array([x_vals])

                        g_ref_grid = np.zeros_like(gm_vals)
                        comp_coords = calc_res.coords['component'].values
                        for c_idx, comp_name in enumerate(comp_coords):
                            comp_str = str(comp_name)
                            if comp_str in mu_dict:
                                g_ref_grid += x_vals[..., c_idx] * mu_dict[comp_str]
                        
                        df_array = gm_vals - g_ref_grid
                        min_df = float(np.nanmin(df_array))
                        
                        if min_df < 0:
                            pen = (min_df ** 2) * w * 2.0 * steep_weight
                            error_list.append(pen) 
                            score_extra += pen
                    except: pass
                    
            except:
                pen = 1e6 * w * steep_weight
                global_crash_penalty += pen
                score_missing += pen
                detail_logs.append(f"[异常] Try块最外层崩溃 | T={T:6.1f} | 惩罚={pen:>10.2f}")

    try:
        active_comps = sorted([str(c).upper() for c in dbf.elements if str(c).upper() != 'VA'])
        axis_comp_local = AXIS_COMP
        liquid_phase_name = 'LIQUID' if 'LIQUID' in all_phases else next((p for p in all_phases if 'LIQ' in p.upper()), None)
    except:
        axis_comp_local = AXIS_COMP
        liquid_phase_name = None

    try:
        if liquid_phase_name:
            for T_liq in [1000.0, 1200.0, 1400.0, 1600.0, 1800.0, 2000.0]:
                try:
                    calc_res = calculate(dbf, comps, [liquid_phase_name], T=T_liq, P=101325, pdens=1000)
                    gs = calc_res.GM.values.flatten()
                    xs = calc_res.X.sel(component=axis_comp_local).values.flatten()
                    
                    valid = ~np.isnan(gs) & ~np.isnan(xs)
                    gs, xs = gs[valid], xs[valid]
                    
                    if len(xs) > 20:
                        sort_idx = np.argsort(xs)
                        x_uni = np.linspace(0.001, 0.999, 500)
                        g_uni = np.interp(x_uni, xs[sort_idx], gs[sort_idx])
                        
                        dx = x_uni[1] - x_uni[0]
                        d2g_dx2 = np.gradient(np.gradient(g_uni, dx), dx)
                        
                        neg_c = d2g_dx2[d2g_dx2 < -5000.0] 
                        if len(neg_c) > 0:
                            pen = 1e11
                            global_crash_penalty += pen
                            score_A += pen
                            break 
                except: pass
    except: pass

    try:
        if liquid_phase_name:
            shield_points = []
            for ds in zpf_ds:
                conds = ds.get('conditions', {})
                t_vals = np.atleast_1d(conds.get('T', [298.15]))
                for i, val_row in enumerate(ds.get('values', [])):
                    has_liq = any(rec[0] == liquid_phase_name for rec in val_row)
                    if has_liq:
                        T_exp = float(t_vals[i] if i < len(t_vals) else t_vals[-1])
                        x_liq = 0.5
                        for rec in val_row:
                            if rec[0] == liquid_phase_name and len(rec) > 2:
                                for c_idx, c_name in enumerate(rec[1]):
                                    if str(c_name).upper() == axis_comp_local and rec[2][c_idx] is not None:
                                        x_liq = float(rec[2][c_idx])
                        shield_points.append((x_liq, T_exp + 150.0))  
            
            shield_points.sort(key=lambda x: x[0])
            filtered_shields = []
            last_x = -1.0
            for x, t in shield_points:
                if x - last_x > 0.05:
                    filtered_shields.append((x, t))
                    last_x = x
                    
            for x_ceil, T_shield in filtered_shields:
                eq_liq = equilibrium(dbf, comps, [liquid_phase_name], {v.T: T_shield, v.P: 101325, v.X(axis_comp_local): x_ceil})
                mu_dict = {}
                try:
                    mu_dict = {str(c): float(eq_liq.MU.sel(component=c).values.flatten()[0]) 
                               for c in eq_liq.MU.coords['component'].values}
                except: continue
                
                for p_name in all_phases:
                    if p_name == liquid_phase_name: continue 
                    try:
                        calc_res = calculate(dbf, comps, [p_name], T=T_shield, P=101325)
                        gm_vals = calc_res.GM.values.squeeze()
                        
                        if 'component' in calc_res.coords:
                            x_vals = calc_res.X.values.squeeze()
                            if gm_vals.ndim == 0:
                                gm_vals, x_vals = np.array([gm_vals]), np.array([x_vals])

                            g_ref_grid = np.zeros_like(gm_vals)
                            comp_coords = calc_res.coords['component'].values
                            for c_idx, comp_name in enumerate(comp_coords):
                                comp_str = str(comp_name)
                                if comp_str in mu_dict:
                                    g_ref_grid += x_vals[..., c_idx] * mu_dict[comp_str]
                            
                            df_array = gm_vals - g_ref_grid
                            
                            x_axis_vals = calc_res.X.sel(component=axis_comp_local).values.squeeze()
                            if x_axis_vals.ndim == 0:
                                x_axis_vals = np.array([x_axis_vals])
                                
                            mask = np.abs(x_axis_vals - x_ceil) < 0.15
                            
                            if np.any(mask):
                                local_df = df_array[mask]
                                min_df = float(np.nanmin(local_df))
                                
                                if min_df < 0:
                                    abs_df = abs(min_df)
                                    capped_df = min(abs_df, 150.0)
                                    ceiling_penalty = 100000.0 + (abs_df * 500.0) + ((capped_df ** 3) * 100.0)
                                    if abs_df > 150.0:
                                        ceiling_penalty += (abs_df - 150.0) * 5000.0
                                        
                                    pen = ceiling_penalty * 100.0 * w * steep_weight
                                    error_list.append(pen)
                                    score_C += pen
                    except: pass
    except: pass

    try:
        if liquid_phase_name:
            max_T_exp = 1000.0
            for ds in zpf_ds:
                t_vals = np.atleast_1d(ds.get('conditions', {}).get('T', [1000.0]))
                max_T_exp = max(max_T_exp, float(np.max(t_vals)))
            
            for T_high in [max_T_exp + 100.0, max_T_exp + 200.0, max_T_exp + 500.0]:
                try:
                    calc_liq = calculate(dbf, comps, [liquid_phase_name], T=T_high, P=101325, pdens=500)
                    g_liq = calc_liq.GM.values.flatten()
                    x_liq = calc_liq.X.sel(component=axis_comp_local).values.flatten()
                    
                    valid_liq = ~np.isnan(g_liq) & ~np.isnan(x_liq)
                    g_liq, x_liq = g_liq[valid_liq], x_liq[valid_liq]
                    
                    if len(x_liq) < 2: continue
                    sort_idx = np.argsort(x_liq)
                    x_liq_sorted, g_liq_sorted = x_liq[sort_idx], g_liq[sort_idx]
                    
                    is_crashed = False
                    for p_name in all_phases:
                        if p_name == liquid_phase_name: continue
                        try:
                            calc_sol = calculate(dbf, comps, [p_name], T=T_high, P=101325, pdens=200)
                            g_sol = calc_sol.GM.values.flatten()
                            x_sol = calc_sol.X.sel(component=axis_comp_local).values.flatten()
                            
                            valid_sol = ~np.isnan(g_sol) & ~np.isnan(x_sol)
                            g_sol, x_sol = g_sol[valid_sol], x_sol[valid_sol]
                            
                            for xs, gs in zip(x_sol, g_sol):
                                gl = np.interp(xs, x_liq_sorted, g_liq_sorted)
                                if gs < gl: 
                                    pen = 1e12
                                    global_crash_penalty += pen 
                                    score_D += pen
                                    is_crashed = True
                                    break
                        except: pass
                        if is_crashed: break
                except: pass
                if global_crash_penalty > 0: break
    except: pass

    try:
        import uuid
        eval_id = str(uuid.uuid4())[:6]
        
        summary_msg = (
            f"=== [Eval ID: {eval_id}] ZPF 分数来源总览 ===\n"
            f"1. 目标相存在 (实际微调): {score_exist:,.2f}\n"
            f"2. 目标相缺失 (缺相/崩溃): {score_missing:,.2f}\n"
            f"3. 多余相压制 (多相惩罚): {score_extra:,.2f}\n"
            f"4. [防线A] 苍穹液相分离 : {score_A:,.2f}\n"
            f"5. [防线C] 动态伴随护盾 : {score_C:,.2f}\n"
            f"6. [防线D] 高温固相复现 : {score_D:,.2f}\n"
            f"7. 其它崩溃/字典缺失   : {global_crash_penalty - score_A - score_D:,.2f}\n"
            f"-------------------------------------\n"
            f"原始 error_list 累加和 : {np.sum(error_list) if error_list else 0.0:,.2f}\n"
            f"全局崩溃分 (crash)     : {global_crash_penalty:,.2f}\n"
            f"=====================================\n\n"
        )
        with open("ZPF_Score_Summary.log", "a", encoding="utf-8") as f:
            f.write(summary_msg)
            
        detail_msg = f"=== [Eval ID: {eval_id}] ZPF 第3部分详细得分追踪 ===\n" + "\n".join(detail_logs) + "\n=====================================\n\n"
        with open("ZPF_Phase_Details.log", "a", encoding="utf-8") as f:
            f.write(detail_msg)
    except Exception:
        pass

    if not error_list:
        return global_crash_penalty, 0.0, 0.0
        
    error_array = np.array(error_list)
    N_points = len(error_list)
    
    tau = 1000.0 
    scaled_errors = error_array / tau
    max_scaled = np.max(scaled_errors)
    sum_exp = np.sum(np.exp(scaled_errors - max_scaled))
    lse_penalty = (max_scaled + np.log(sum_exp) - np.log(N_points)) * tau
    lse_penalty = max(lse_penalty, 0.0)
    
    sum_penalty = np.sum(error_array)
    
    weight_LSE = 10.0
    weight_Sum = 0.05
    
    final_penalty = (lse_penalty * weight_LSE) + (sum_penalty * weight_Sum)
    
    return final_penalty + global_crash_penalty, lse_penalty * weight_LSE, sum_penalty

def get_adaptive_config(trial_number, total_trials):
    t1 = int(total_trials * (2000 / 15000.0))
    t2 = int(total_trials * (4000 / 15000.0))
    min_dev = 0.05
    max_dev = 1.0
    
    if trial_number < t1:
        return max_dev, "Active_Search" 
    elif trial_number < t2:
        progress = (trial_number - t1) / (t2 - t1)
        factor = max_dev - (max_dev - min_dev) * progress
        return factor, "Annealing"
    else:
        return min_dev, "Polishing"

def evaluate_hybrid_params(trial_number, params_dict, tdb_path, data_path, allowed_dev, stage):
    try:
        cache = get_worker_state(tdb_path, data_path)
        dbf, contexts, base_scores, zpf_ds, symbols_to_fit = [cache[k] for k in ['dbf', 'contexts', 'base_scores', 'zpf_datasets', 'symbols_to_fit']]
        
        proposed_params = [params_dict[s] for s in symbols_to_fit]
        curr_scores = {meta: sum(evaluate_residual(res, proposed_params) for res in objs) for meta, objs in contexts.items()}

        total_score = 0.0
        is_penalized = False
        penalizer = ""
        
        W_PROP = {"HM": 5.0, "ACR": 15.0, "SM": 0.02, "ZPF": 100.0}
        W_SRC  = {"EXP": 100.0, "DFT": 80.0, "EST": 20.0}

        for (p_type, source), curr_ll in curr_scores.items():
            val = curr_ll if np.isfinite(curr_ll) else -1e9
            l0 = base_scores.get((p_type, source), 0.0)
            
            if p_type in ["HM", "ACR"]:
                limit = l0 - max(abs(l0) * allowed_dev, 1)
                if val < limit:
                    is_penalized, penalizer = True, f"{p_type}_{source}"
            
            total_score += val * W_PROP.get(p_type, 1.0) * W_SRC.get(source, 1.0)

        worker_acr_l0 = base_scores.get(('ACR', 'EXP'), 0.0)
        worker_acr_limit = worker_acr_l0 - max(abs(worker_acr_l0) * allowed_dev, 20)

        if is_penalized:
            final_score = -1e16 - abs(total_score * 0.001)
            icon, status = "❌", penalizer
            zpf_log_str = "ZPF[🔥SKIPPED]"
        else:
            zpf_df_err, zpf_lse, zpf_sum = calculate_driving_force_zpf(dbf, zpf_ds, params_dict)
            
            if np.isnan(zpf_df_err) or np.isnan(total_score):
                return -1e16, f"[❌] Trial {trial_number:04d} (Dev:{allowed_dev*100:.3f}%) | NaN_Err  | Score: nan | ZPF_DF: nan | (Stoichiometric failed)"
                
            final_score = total_score - zpf_df_err * W_PROP["ZPF"]
            icon, status = "✅", "Passed"
            zpf_log_str = f"ZPF[Tot:{zpf_df_err:>6.0f}|LSE:{zpf_lse:>6.0f}|Sum:{zpf_sum:>6.0f}]"

        prop_types = set([k[0] for k in curr_scores.keys()])
        log_props = []
        for pt in sorted(prop_types):
            parts = []
            if (pt, 'EXP') in curr_scores: parts.append(f"E:{curr_scores[(pt, 'EXP')]:.0f}")
            if (pt, 'DFT') in curr_scores: parts.append(f"D:{curr_scores[(pt, 'DFT')]:.0f}")
            if (pt, 'EST') in curr_scores: parts.append(f"S:{curr_scores[(pt, 'EST')]:.0f}")
            if parts: log_props.append(f"{pt}[{'|'.join(parts)}]")
                
        prop_log_str = " ".join(log_props)
        dev_pct = allowed_dev * 100
        
        log_msg = f"[{icon}] Trial {trial_number:04d} (Dev:{dev_pct:.3f}%) | {status:<8} | Score: {final_score:,.0f} | {zpf_log_str} | {prop_log_str} | [W_ACR_Lim:{worker_acr_limit:,.0f}]"
        
        gc.collect()
        return final_score, log_msg
    
    except Exception as e:
        return -1e17, f"[💥] Trial {trial_number:04d} crashed: {e}"

def run_baseline_and_clear_cache(tdb_path, data_path, dbf_init, syms, ivs):
    global _WORKER_CACHE
    print("\n▶️ [DEBUG] 正在测算初始 TDB 的物理基准偏差 (Baseline L0) ... (请稍候)")
    
    init_cache = get_worker_state(tdb_path, data_path)
    base_scores = init_cache['base_scores']
    zpf_ds = init_cache['zpf_datasets']
    init_ivs = init_cache['initial_values']
    init_params_dict = {s: val for s, val in zip(syms, init_ivs)}
    zpf_l0, lse_l0, sum_l0 = calculate_driving_force_zpf(dbf_init, zpf_ds, init_params_dict)
    
    print("\n" + "="*55)
    print(" 🏆 初始 TDB 物理属性基准线 (Baseline L0) ")
    print("="*55)
    for (p_type, source), score in base_scores.items():
        print(f"   ➤ 初始 {p_type:<5} ({source}): {score:>15,.2f}")
    print(f"   ➤ 初始 ZPF_DF 相图惩罚: {zpf_l0:,.2f} (LSE: {lse_l0:,.0f} | Sum: {sum_l0:,.0f})")
    print("="*55 + "\n")
    
    _WORKER_CACHE.clear()

if __name__ == "__main__":
    print("▶️ [DEBUG] 系统正在启动，加载日志模块...")
    logger = setup_logging()
    
    TDB_INPUT, DATA_INPUT = "test3.tdb", "input-data3" 
    DB_FILE = "test3.db"
    DB_URL = f"sqlite:///{DB_FILE}" 
    
    is_new = not os.path.exists(DB_FILE)

    print("▶️ [DEBUG] 正在读取初始 TDB 物理模型...")
    dbf_init = Database(TDB_INPUT)
    syms = sorted([s for s in dbf_init.symbols.keys() if s.startswith('V')])
    
    entropy_syms = set()
    with open(TDB_INPUT, 'r', encoding='utf-8') as f:
        matches = re.findall(r'T\s*\*\s*(VV\d+)|(VV\d+)\s*\*\s*T', f.read())
        for m in matches:
            if m[0]: entropy_syms.add(m[0]); 
            if m[1]: entropy_syms.add(m[1])

    ivs = [float(dbf_init.symbols[s].subs({v.T: 298.15})) if hasattr(dbf_init.symbols[s], 'subs') else float(dbf_init.symbols[s]) for s in syms]
    run_baseline_and_clear_cache(TDB_INPUT, DATA_INPUT, dbf_init, syms, ivs)
    gc.collect()

    print(f"▶️ [DEBUG] 正在连接本地数据库 {DB_FILE}...")
    connect_args = {"timeout": 60.0}
    sampler = optuna.samplers.CmaEsSampler(n_startup_trials=500, popsize=64, restart_strategy="ipop", inc_popsize=2)
    study = optuna.create_study(
        study_name="entropy_opt", 
        storage=optuna.storages.RDBStorage(DB_URL, engine_kwargs={"connect_args": connect_args}), 
        direction="maximize", 
        sampler=sampler, 
        load_if_exists=True
    )
    
    with sqlite3.connect(DB_FILE, timeout=60.0) as conn: 
        conn.execute("PRAGMA journal_mode=WAL;")
    
    if is_new:
        study.enqueue_trial({s: val for s, val in zip(syms, ivs)})

    print("▶️ [DEBUG] 正在唤醒 Dask 集群并分配内存池...")
    WORKERS = 4
    TOTAL_TRIALS = 50 
    
    MAX_TRIALS_PER_RUN = 2
    SCHEDULER_FILE = "Optimization_Scheduler.json"

    try:
        cluster = LocalCluster(
            n_workers=WORKERS, 
            threads_per_worker=1, 
            memory_limit='8GB', 
            dashboard_address=None, 
            host='127.0.0.1',
            scheduler_port=0,         
            silence_logs=logging.ERROR 
        )
        temp_client = Client(cluster)
        temp_client.write_scheduler_file(SCHEDULER_FILE)
        temp_client.close()

        print("▶️ [DEBUG] 集群启动成功！即将派发计算任务...")
        with Client(scheduler_file=SCHEDULER_FILE) as client:
            completed = len(study.trials)
            run_target = min(completed + MAX_TRIALS_PER_RUN, TOTAL_TRIALS)
            
            while completed < run_target:
                batch_size = min(WORKERS, run_target - completed)
                trials_batch, futures = [], []
                
                for _ in range(batch_size):
                    trial = study.ask()
                    shrink, stage = get_adaptive_config(trial.number, TOTAL_TRIALS)
                    p_dict = {}
                    
                    constant_sigma_hm = 0.2
                    constant_sigma_sm = 0.1
                    hm_min = 1000.0
                    sm_min = 10.0
                    
                    for s, iv in zip(syms, ivs):
                        mu = float(iv)
                        
                        if s in entropy_syms:
                            sig = min(max(abs(mu) * constant_sigma_sm, sm_min), 100.0)
                        else:
                            sig = max(abs(mu) * constant_sigma_hm, hm_min)
                            
                        p_dict[s] = trial.suggest_float(s, mu - 3 * sig, mu + 3 * sig)
                        
                    trials_batch.append(trial)
                    futures.append(client.submit(evaluate_hybrid_params, trial.number, p_dict, TDB_INPUT, DATA_INPUT, shrink, stage))
                
                results = client.gather(futures)
                for trial, (score, log_msg) in zip(trials_batch, results):
                    study.tell(trial, score)
                    logger.info(log_msg)
                completed += len(futures)
                print(f"🧬 进度: {completed}/{TOTAL_TRIALS} | 进化中...", end='\r')
            
            print("\n⏳ 本批次演化结束，准备释放物理内存...")
            time.sleep(2)
            
        try:
            client.close(timeout=3)
            cluster.close(timeout=3)
        except Exception:
            pass 

        os._exit(0) 
        
    except Exception as e:
        print(f"\n❌ 执行异常: {traceback.format_exc()}")
        os._exit(1)
