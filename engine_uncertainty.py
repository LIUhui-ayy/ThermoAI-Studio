from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors
import matplotlib.patches as mpatches
import matplotlib.lines as mlines
from scipy.interpolate import interp1d
import seaborn as sns
import numpy as np
import io
import base64
import os
import optuna
import sqlite3
import traceback
from pycalphad import Database, binplot, calculate, equilibrium, variables as v
from espei.datasets import load_datasets, recursive_glob
from tinydb import where
import re
from collections import OrderedDict
from tqdm import tqdm

router = APIRouter()

# Global matplotlib style setup
plt.rcParams.update({
    'font.family': 'serif',
    'font.serif': ['Times New Roman'],
    'mathtext.fontset': 'stix',
    'axes.linewidth': 1.5,
    'xtick.direction': 'in',
    'ytick.direction': 'in',
    'xtick.top': True,
    'ytick.right': True,
    'xtick.major.size': 6,
    'ytick.major.size': 6,
    'xtick.major.width': 1.5,
    'ytick.major.width': 1.5,
    'font.size': 14,
    'axes.labelsize': 14,
    'axes.titlesize': 14,
    'xtick.labelsize': 12,
    'ytick.labelsize': 12,
    'legend.fontsize': 11,
    'figure.dpi': 600,
    'savefig.dpi': 600
})

THEME_COLORS = {
    'scatter': '#135D78',
    'ci_68': '#B70D11',
    'ci_95': '#DC6F39',
}

CUSTOM_PHASE_COLORS = {
    'BETA': '#135D78',       
    'EPSILON': '#8E6D59',    
    'FCC_A1': '#B70D11',     
    'GAMMA': '#DC6F39',      
    'HCP_A3': '#243B4A',     
    'LIQUID': '#744162',     
}

class UncertaintyPlotRequest(BaseModel):
    uq_type: str
    tdb_file: str
    db_file: str
    data_path: str
    min_score: float
    n_samples: int
    t_calc: float
    t_min: float
    t_max: float
    t_step: float
    x_min: float
    x_max: float
    x_step: float
    target_phase: str
    target_comp: str
    target_phases: List[str]

def extract_ensemble_parameters(db_file: str, min_score: float, n_samples: int):
    if not os.path.exists(db_file):
        raise FileNotFoundError(f"Database {db_file} not found")
    
    study_name = "entropy_opt"
    try:
        study = optuna.load_study(study_name=study_name, storage=f"sqlite:///{db_file}")
    except Exception as e:
        raise Exception(f"Failed to load study: {e}")
        
    ensemble_params = [t.params for t in study.trials if t.state == optuna.trial.TrialState.COMPLETE and t.value is not None and t.value > min_score]
    
    if len(ensemble_params) > n_samples:
        indices = np.linspace(0, len(ensemble_params)-1, n_samples, dtype=int)
        ensemble_params = [ensemble_params[i] for i in indices]
    
    return ensemble_params

@router.post("/plot-uncertainty")
def plot_uncertainty(req: UncertaintyPlotRequest):
    try:
        if not os.path.exists(req.tdb_file):
            raise Exception(f"TDB file not found: {req.tdb_file}")
            
        dbf = Database(req.tdb_file)
        
        comps = []
        for phase in dbf.phases.values():
            for con in phase.constituents:
                comps.extend(list(con))
        comps = list(set(comps))
        comps = [c for c in comps if c != 'VA'] + ['VA']
        target_comp = req.target_comp
        if target_comp not in comps:
            target_comp = comps[1] if len(comps)>1 else comps[0]
            
        ensemble = extract_ensemble_parameters(req.db_file, req.min_score, req.n_samples)
        if not ensemble:
            raise Exception("No valid ensemble parameters found based on min_score")

        fig, ax = plt.subplots(figsize=(6.5, 6))

        if req.uq_type == 'INVARIANT':
            target_phases = req.target_phases
            search_conds = {
                v.P: 101325, 
                v.T: (req.t_min, req.t_max, req.t_step),
                v.X(target_comp): (req.x_min, req.x_max, req.x_step)
            }
            invariant_points = []
            for params in ensemble:
                for sym, val in params.items(): 
                    if sym in dbf.symbols:
                        dbf.symbols[sym] = float(val)
                try:
                    eq = equilibrium(dbf, comps, target_phases, search_conds)
                    phase_array = eq.Phase.values
                    if 'LIQUID' in phase_array:
                        liquid_indices = np.argwhere(phase_array == 'LIQUID')
                        t_dim_idx = eq.Phase.dims.index('T')
                        min_t_idx = np.min(liquid_indices[:, t_dim_idx])
                        T_e = float(eq.T.values[min_t_idx])
                        min_t_records = liquid_indices[liquid_indices[:, t_dim_idx] == min_t_idx]
                        first_record = min_t_records[0]
                        isel_dict = {dim: first_record[i] for i, dim in enumerate(eq.Phase.dims)}
                        X_e = float(eq.X.sel(component=target_comp).isel(**isel_dict).values)
                        invariant_points.append([X_e, T_e])
                except Exception:
                    continue
            
            points = np.array(invariant_points)
            if len(points) < 5:
                raise Exception("Not enough invariant points found in search space")
                
            sns.kdeplot(x=points[:, 0], y=points[:, 1], ax=ax, levels=[0.05], color=THEME_COLORS['ci_95'], 
                        linestyles="dashed", linewidths=2.0, fill=False, bw_adjust=1.5)
            sns.kdeplot(x=points[:, 0], y=points[:, 1], ax=ax, levels=[0.32], color=THEME_COLORS['ci_68'], 
                        linestyles="solid", linewidths=2.5, fill=False, bw_adjust=1.5)
            ax.scatter(points[:, 0], points[:, 1], color=THEME_COLORS['scatter'], s=25, alpha=0.85, edgecolors='none', zorder=10)
            
            scatter_leg = mlines.Line2D([], [], color='white', marker='o', markerfacecolor=THEME_COLORS['scatter'], markersize=7, label='Invariant Samples')
            ci_95_leg = mlines.Line2D([], [], color=THEME_COLORS['ci_95'], linestyle='dashed', linewidth=2.0, label='95% CI')
            ci_68_leg = mlines.Line2D([], [], color=THEME_COLORS['ci_68'], linestyle='solid', linewidth=2.5, label='68% CI')
            ax.legend(handles=[scatter_leg, ci_95_leg, ci_68_leg], loc='upper left', frameon=True, edgecolor='black', fontsize=12)
            ax.margins(x=0.15, y=0.15)
            ax.set_box_aspect(1) 
            ax.set_xlabel(f"Mole Fraction of {target_comp}", labelpad=10, fontsize=15)
            ax.set_ylabel(r"Invariant Temperature (K)", labelpad=10, fontsize=15)

        elif req.uq_type == 'PD':
            conds = {v.P: 101325, v.T: (req.t_min, req.t_max, req.t_step), v.X(target_comp): (req.x_min, req.x_max, req.x_step)}
            phases = list(dbf.phases.keys())
            
            tie_line_color = '#EDE7D5'
            default_greens = ['#008000', '#00FF00', '#2CA02C']
            for params in ensemble:
                for sym, val in params.items(): 
                    if sym in dbf.symbols:
                        dbf.symbols[sym] = float(val)
                try:
                    binplot(dbf, comps, phases, conds, plot_kwargs={'ax': ax, 'linewidth': 1.2})
                except Exception: 
                    continue

            color_map = {}
            legend = ax.get_legend()
            if legend:
                handles = getattr(legend, 'legend_handles', getattr(legend, 'legendHandles', []))
                for text, handle in zip(legend.get_texts(), handles):
                    label = text.get_text()
                    if label in CUSTOM_PHASE_COLORS:
                        try: orig_c = handle.get_facecolor()
                        except AttributeError: orig_c = handle.get_color()
                        if isinstance(orig_c, np.ndarray) and orig_c.size > 0: orig_c = orig_c[0]
                        try:
                            orig_hex = mcolors.to_hex(orig_c, keep_alpha=False).upper()
                            color_map[orig_hex] = CUSTOM_PHASE_COLORS[label].upper()
                        except Exception: pass

            PDUQ_ALPHA = 0.03
            LINE_WIDTH = 1.2

            for line in ax.get_lines():
                try:
                    c_hex = mcolors.to_hex(line.get_color(), keep_alpha=False).upper()
                    if c_hex in color_map: 
                        line.set_color(mcolors.to_rgba(color_map[c_hex], alpha=PDUQ_ALPHA))
                        line.set_linewidth(LINE_WIDTH)
                    elif c_hex in default_greens: 
                        line.set_color(mcolors.to_rgba(tie_line_color, alpha=0.01))
                        line.set_linewidth(0.5)
                except Exception: pass

            for collection in ax.collections:
                try:
                    edge_colors = collection.get_edgecolors()
                    face_colors = collection.get_facecolors()
                    c_hex = None
                    if len(edge_colors) > 0 and tuple(edge_colors[0][:3]) != (0,0,0): 
                        c_hex = mcolors.to_hex(edge_colors[0], keep_alpha=False).upper()
                    elif len(face_colors) > 0: 
                        c_hex = mcolors.to_hex(face_colors[0], keep_alpha=False).upper()
                    if c_hex:
                        if c_hex in color_map: 
                            collection.set_facecolor('none')
                            collection.set_edgecolor(mcolors.to_rgba(color_map[c_hex], alpha=PDUQ_ALPHA))
                            collection.set_linewidth(LINE_WIDTH)
                        elif c_hex in default_greens:
                            collection.set_facecolor('none')
                            collection.set_edgecolor(mcolors.to_rgba(tie_line_color, alpha=0.01))
                            collection.set_linewidth(0.5)
                except Exception: pass

            if ax.get_legend() is not None: ax.get_legend().remove()
            ax.set_title("")           
            for txt in list(ax.texts): txt.remove()

            legend_elements = [
                mpatches.Patch(facecolor=color, edgecolor='black', linewidth=1.0, label=phase)
                for phase, color in CUSTOM_PHASE_COLORS.items() if phase in phases
            ]
            ax.legend(handles=legend_elements, loc='best', frameon=True, edgecolor='black', fontsize=11)
            ax.set_box_aspect(1)
            ax.set_xlabel(f"Mole Fraction of {target_comp}", fontsize=14, labelpad=10)
            ax.set_ylabel(r"Temperature (K)", fontsize=14, labelpad=10)
            ax.set_xlim(req.x_min, req.x_max)
            ax.set_ylim(req.t_min, req.t_max)
            
        elif req.uq_type == 'ACR':
            R = 8.3145
            x_grid = np.linspace(0.01, 0.99, 100) 
            all_act = []
            for params in ensemble:
                for sym, val in params.items():
                    if sym in dbf.symbols:
                        dbf.symbols[sym] = float(val)
                try:
                    comps_without_va = [c for c in comps if c != 'VA']
                    other_comp = [c for c in comps_without_va if c != target_comp][0]
                    eq_pure = equilibrium(dbf, comps, [req.target_phase], {v.P: 101325, v.T: req.t_calc, v.X(other_comp): 1e-9})
                    mu_pure = float(eq_pure.MU.sel(component=target_comp).values.flatten()[0])

                    eq_curve = equilibrium(dbf, comps, [req.target_phase], {v.P: 101325, v.T: req.t_calc, v.X(target_comp): x_grid})
                    x_calc = eq_curve.X.sel(component=target_comp, vertex=0).values.flatten()
                    mu_calc = eq_curve.MU.sel(component=target_comp).values.flatten()
                    
                    valid = ~np.isnan(mu_calc)
                    if not np.any(valid): continue
                    
                    act_calc = np.exp((mu_calc[valid] - mu_pure) / (R * req.t_calc))
                    x_calc_valid = x_calc[valid]
                    
                    sort_idx = np.argsort(x_calc_valid)
                    f_interp = interp1d(x_calc_valid[sort_idx], act_calc[sort_idx], kind='linear', bounds_error=False, fill_value="extrapolate")
                    all_act.append(f_interp(x_grid))
                except Exception:
                    continue

            if all_act:
                all_act = np.array(all_act)
                act_mean = np.mean(all_act, axis=0)
                act_lower = np.percentile(all_act, 2.5, axis=0)
                act_upper = np.percentile(all_act, 97.5, axis=0)
                
                ax.fill_between(x_grid, act_lower, act_upper, color='#135D78', alpha=0.35, label='95% Confidence Interval')
                ax.plot(x_grid, act_mean, color='#135D78', linewidth=2.5, label='Calculated (Ensemble Mean)')
            
            ax.plot([0, 1], [0, 1], color='gray', linestyle='--', alpha=0.5, label='Ideal', linewidth=1.2)
            ax.legend(loc='lower right', frameon=True, edgecolor='black', fontsize=10)
            ax.set_box_aspect(1)
            ax.set_xlabel(f"Mole Fraction of {target_comp}", fontsize=14, labelpad=10)
            ax.set_ylabel(f"Activity of {target_comp}", fontsize=14, labelpad=10)
            ax.set_xlim(0, 1)
            ax.set_ylim(0, 1)

        elif req.uq_type == 'HM':
            x_grid = np.linspace(0.01, 0.99, 150) 
            all_hm = []
            for params in ensemble:
                for sym, val in params.items():
                    if sym in dbf.symbols:
                        dbf.symbols[sym] = float(val)
                try:
                    res = calculate(dbf, comps, req.target_phase, T=req.t_calc, P=101325, output='HM_MIX')
                    x_calc = res.X.sel(component=target_comp).values.flatten()
                    hm_calc = res.HM_MIX.values.flatten()
                    sort_idx = np.argsort(x_calc)
                    f_interp = interp1d(x_calc[sort_idx], hm_calc[sort_idx], kind='linear', bounds_error=False, fill_value="extrapolate")
                    all_hm.append(f_interp(x_grid))
                except Exception:
                    continue
            if all_hm:
                all_hm = np.array(all_hm)
                hm_mean = np.mean(all_hm, axis=0)
                hm_lower = np.percentile(all_hm, 2.5, axis=0)
                hm_upper = np.percentile(all_hm, 97.5, axis=0)
                
                ax.fill_between(x_grid, hm_lower, hm_upper, color='#135D78', alpha=0.35, label='95% Confidence Interval')
                ax.plot(x_grid, hm_mean, color='#135D78', linewidth=2.5, label='Calculated (Ensemble Mean)')
            
            ax.legend(loc='best', frameon=True, edgecolor='black', fontsize=10)
            ax.set_box_aspect(1)
            ax.set_xlabel(f"Mole Fraction of {target_comp}", fontsize=14, labelpad=10)
            ax.set_ylabel(r"Mixing Enthalpy ($\Delta H_{\mathrm{mix}}$, J/mol)", fontsize=14, labelpad=10)
            ax.set_xlim(0, 1)

        elif req.uq_type == 'GM':
            phases_to_calc = [p for p in CUSTOM_PHASE_COLORS.keys() if p in dbf.phases]
            x_grid = np.linspace(0.001, 0.999, 200)
            solution_data = {p: [] for p in phases_to_calc}
            line_data = {p: {'x': [], 'gm': []} for p in phases_to_calc}

            for params in ensemble:
                for sym, val in params.items(): 
                    if sym in dbf.symbols:
                        dbf.symbols[sym] = float(val)
                for phase_name in phases_to_calc:
                    try:
                        if phase_name in ['FCC_A1', 'HCP_A3', 'LIQUID']:
                            res = calculate(dbf, comps, phase_name, P=101325, T=req.t_calc, output='GM', pdens=200)
                            x_calc = res.X.sel(component=target_comp).values.flatten()
                            gm_calc = res.GM.values.flatten()
                            valid = ~np.isnan(gm_calc) & ~np.isnan(x_calc)
                            x_valid = x_calc[valid]
                            gm_valid = gm_calc[valid]
                            if len(x_valid) == 0: continue
                            x_rounded = np.round(x_valid, 3)
                            unique_x = np.unique(x_rounded)
                            min_gm = np.array([np.min(gm_valid[x_rounded == ux]) for ux in unique_x])
                            f_interp = interp1d(unique_x, min_gm, kind='linear', bounds_error=False, fill_value=np.nan)
                            solution_data[phase_name].append(f_interp(x_grid))
                        elif phase_name == 'GAMMA':
                            eq = equilibrium(dbf, comps, [phase_name], {v.P: 101325, v.T: req.t_calc, v.X(target_comp): x_grid})
                            gm = eq.GM.values.flatten()
                            solution_data[phase_name].append(gm)
                        else: 
                            res = calculate(dbf, comps, phase_name, P=101325, T=req.t_calc, output='GM')
                            x_c = res.X.sel(component=target_comp).values.flatten()
                            gm = res.GM.values.flatten()
                            min_idx = np.argmin(gm)
                            line_data[phase_name]['x'].append(x_c[min_idx])
                            line_data[phase_name]['gm'].append(gm[min_idx])
                    except Exception:
                        continue

            for phase_name in phases_to_calc:
                color = CUSTOM_PHASE_COLORS[phase_name]
                if phase_name in ['FCC_A1', 'HCP_A3', 'LIQUID', 'GAMMA']:
                    if len(solution_data[phase_name]) == 0: continue
                    all_gm = np.array(solution_data[phase_name])
                    with warnings.catch_warnings():
                        warnings.simplefilter("ignore", category=RuntimeWarning)
                        gm_mean = np.nanmean(all_gm, axis=0)
                        gm_lower = np.nanpercentile(all_gm, 2.5, axis=0)
                        gm_upper = np.nanpercentile(all_gm, 97.5, axis=0)
                    valid_mask = ~np.isnan(gm_mean)
                    if np.any(valid_mask):
                        ax.fill_between(x_grid[valid_mask], gm_lower[valid_mask], gm_upper[valid_mask], color=color, alpha=0.35, linewidth=0, zorder=2)
                        lw = 3.0 if phase_name in ['FCC_A1', 'HCP_A3', 'LIQUID'] else 2.5
                        ax.plot(x_grid[valid_mask], gm_mean[valid_mask], color=color, linewidth=lw, zorder=3)
                else:
                    if len(line_data[phase_name]['gm']) == 0: continue
                    all_x = np.array(line_data[phase_name]['x'])
                    all_gm = np.array(line_data[phase_name]['gm'])
                    x_mean = np.nanmean(all_x)
                    gm_mean = np.nanmean(all_gm)
                    gm_lower = np.nanpercentile(all_gm, 2.5)
                    gm_upper = np.nanpercentile(all_gm, 97.5)
                    ax.errorbar(x_mean, gm_mean, yerr=[[gm_mean - gm_lower], [gm_upper - gm_mean]], fmt='o', color=color, capsize=4, markeredgecolor='white', markersize=8, linewidth=1.5, zorder=10)

            legend_elements = [mlines.Line2D([], [], color=CUSTOM_PHASE_COLORS[p], linewidth=3.5, label=p) for p in phases_to_calc]
            legend_elements.append(mpatches.Patch(facecolor='gray', alpha=0.35, linewidth=0, label='95% Confidence Interval'))
            ax.legend(handles=legend_elements, loc='best', frameon=True, edgecolor='black', fontsize=11)
            ax.set_box_aspect(1)
            ax.set_xlabel(f"Mole Fraction of {target_comp}", labelpad=10)
            ax.set_ylabel(r"Molar Gibbs Energy ($G_{\mathrm{m}}$, J/mol)", labelpad=10)
            ax.set_xlim(0, 1)
            
        elif req.uq_type == 'FRACTION':
            x_grid = np.linspace(0.01, 0.99, 150)
            all_frac = []
            for params in ensemble:
                for sym, val in params.items():
                    if sym in dbf.symbols:
                        dbf.symbols[sym] = float(val)
                try:
                    eq = equilibrium(dbf, comps, list(dbf.phases.keys()), {v.P: 101325, v.T: req.t_calc, v.X(target_comp): x_grid})
                    # eq.NP has dimensions (P, T, X, vertex) but we mapped over X, so it's usually (P, T, X, phase) or similar depending on pycalphad version.
                    # Usually, NP has 'vertex' dimension and 'Phase' has 'vertex' dimension. 
                    # For phase fraction of a specific phase across x_grid:
                    # Let's iterate manually or safely
                    frac_arr = []
                    for i in range(len(x_grid)):
                        isel_dict = {dim: 0 for dim in eq.Phase.dims if dim not in ['X_'+target_comp, 'component', 'vertex']}
                        if 'X_'+target_comp in eq.Phase.dims:
                            isel_dict['X_'+target_comp] = i
                        
                        phases_i = eq.Phase.isel(**isel_dict).values
                        np_i = eq.NP.isel(**isel_dict).values
                        
                        target_idx = np.where(phases_i == req.target_phase)[0]
                        if len(target_idx) > 0:
                            frac_arr.append(np.sum(np_i[target_idx]))
                        else:
                            frac_arr.append(0.0)
                    all_frac.append(frac_arr)
                except Exception:
                    continue

            if all_frac:
                all_frac = np.array(all_frac)
                frac_mean = np.mean(all_frac, axis=0)
                frac_lower = np.percentile(all_frac, 2.5, axis=0)
                frac_upper = np.percentile(all_frac, 97.5, axis=0)
                ax.fill_between(x_grid, frac_lower, frac_upper, color='#135D78', alpha=0.35, label='95% Confidence Interval')
                ax.plot(x_grid, frac_mean, color='#135D78', linewidth=2.5, label='Calculated (Ensemble Mean)')
            
            ax.legend(loc='best', frameon=True, edgecolor='black', fontsize=10)
            ax.set_box_aspect(1)
            ax.set_xlabel(f"Mole Fraction of {target_comp}", fontsize=14, labelpad=10)
            ax.set_ylabel(f"Phase Fraction of {req.target_phase}", fontsize=14, labelpad=10)
            ax.set_xlim(0, 1)
            ax.set_ylim(0, 1)
            
        else:
            raise Exception("Unsupported UQ type")

        for spine in ax.spines.values(): spine.set_linewidth(1.5)
        ax.tick_params(which='both', direction='in', top=True, right=True, width=1.5, length=6)
        
        plt.tight_layout()
        buf = io.BytesIO()
        fig.savefig(buf, format='png', dpi=300, bbox_inches='tight')
        plt.close(fig)
        img_str = base64.b64encode(buf.getvalue()).decode('utf-8')
        
        return {"status": "success", "image": img_str}
        
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
