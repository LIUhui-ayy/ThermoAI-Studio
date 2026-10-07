import numpy as np
import os
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.figure import Figure
from matplotlib.patches import Patch
import matplotlib.patches as mpatches
from matplotlib.lines import Line2D
import logging
import time
from collections import OrderedDict
from itertools import chain
import pickle
import symengine
import xarray as xr
import seaborn as sns
from scipy.stats import gaussian_kde
from scipy.ndimage import gaussian_filter
from pycalphad import Database, variables as v, calculate, equilibrium
try:
    from pduq.uq_plot import plot_property as pduq_plot_property  # type: ignore
    HAS_PDUQ_PLOT = True
except ImportError:
    HAS_PDUQ_PLOT = False
try:
    from pycalphad.constants import R  # type: ignore
except ImportError:
    # Fallback to a standard value if pycalphad.constants is missing
    R = 8.3145
from sklearn.preprocessing import StandardScaler
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score

# Configure logging
logger = logging.getLogger("pduq_core")

# --- PDUQ Core Functions ---

def database_symbols_to_fit(dbf):
    """
    Extract symbols from the database that are intended to be fit.
    IMPORTANT: ESPEI sorts symbols alphabetically before MCMC, so we MUST sort them
    to correctly zip them with trace.npy columns!
    """
    v_symbols = [s for s in dbf.symbols if s.startswith('V')]
    if v_symbols:
        return sorted(v_symbols)
        
    # General Fallback
    all_keys = list(dbf.symbols.keys())
    exclude = {'R', 'T', 'P', 'V', 'G', 'H', 'S', 'CP', 'F', 'U', 'M', 'N', 'VS', 'VA', 'T0', 'TC'}
    fallback_symbols = []
    for s in all_keys:
        if s.upper() in exclude: continue
        if s.upper().startswith('GHSER'): continue
        fallback_symbols.append(s)
        
    return sorted(fallback_symbols)

def eq_calc_(dbf, comps, phases, conds, paramA, symbols_to_fit, eq_callables=None):
    param_dict = {}
    for name, val in zip(symbols_to_fit, paramA):
        if not np.isfinite(val):
            logging.warning(f"PDUQ: Non-finite value {val} for symbol {name}. Using 0.0 instead.")
            val = 0.0
        param_dict[name] = float(val)

    parameters = OrderedDict(sorted(param_dict.items(), key=str))

    if eq_callables is None:
        eq_result = equilibrium(dbf, comps, phases, conds, parameters=parameters)
    else:
        eq_result = equilibrium(dbf, comps, phases, conds, parameters=parameters, callables=eq_callables)

    return eq_result

def eq_calc_chunk_(chunk, dbf, comps, phases, conds, params, symbols_to_fit, eq_callables=None):
    eq_result = []
    for index in chunk:
        paramA = np.squeeze(params[index, :])
        eq_result_ = eq_calc_(dbf, comps, phases, conds, paramA, symbols_to_fit, eq_callables)
        eq_result += [eq_result_]

    msg = str(chunk) + ' ' + str(time.time())
    logging.info(msg)
    return eq_result

def eq_calc_samples(dbf, conds, params, client=None, comps=None, phases=None, savef=None, symbols_to_fit=None):
    if comps is None:
        comps = list(dbf.elements)
    if phases is None:
        phases = list(dbf.phases.keys())
    if symbols_to_fit is None:
        symbols_to_fit = database_symbols_to_fit(dbf)
    
    logging.info(f"PDUQ: Found {len(symbols_to_fit)} symbols to fit: {symbols_to_fit}")
    
    eq_callables = None
    kwargs = {'dbf': dbf, 'comps': comps, 'phases': phases, 'conds': conds,
              'params': params, 'symbols_to_fit': symbols_to_fit,
              'eq_callables': eq_callables}

    neq = params.shape[0]
    if neq == 0: return None

    nch = neq if neq < 20 else 20
    chunks = [list(range(neq))[ii::nch] for ii in range(nch)]

    if client is None:
        eqL = []
        for chunk in chunks:
            if not chunk: continue
            eqL += eq_calc_chunk_(chunk, **kwargs)
    else:
        # Scatter DBF to workers
        dbf_future = client.scatter(dbf, broadcast=True)
        kwargs['dbf'] = dbf_future
        try:
            A = client.map(eq_calc_chunk_, chunks, **kwargs)
            eqL = client.gather(A)
            eqL = list(chain.from_iterable(eqL))
        except Exception as e:
            logging.error(f"PDUQ: Dask map/gather failed: {e}. Falling back to serial.")
            kwargs.pop('dbf', None) # Remove future
            eqL = []
            for chunk in chunks:
                if not chunk: continue
                eqL += eq_calc_chunk_(chunk, dbf=dbf, **kwargs)

    if not eqL: return None
    
    eqC = xr.concat(eqL, 'sample')
    eqC.coords['sample'] = np.arange(neq)
    
    logging.info(f"Equilibrium calculation finished. Shape: {eqC.dims}")

    if savef is not None:
        with open(savef, 'wb') as buff:
            pickle.dump(eqC, buff)

    return eqC

def invariant_samples(dbf, params, X, P, Tl, Tu, comp, client=None, comps=None, phases=None):
    if comps is None: comps = list(dbf.elements)
    if phases is None: phases = list(dbf.phases.keys())

    neq = params.shape[0]
    symbols_to_fit = database_symbols_to_fit(dbf)
    eq_callables = None

    kwargs = {'dbf': dbf, 'comps': comps, 'phases': phases,
              'X': X, 'P': P, 'Tl': Tl, 'Tu': Tu, 'comp': comp,
              'params': params, 'symbols_to_fit': symbols_to_fit,
              'eq_callables': eq_callables}

    if client is None:
        invL = []
        for ii in range(neq):
            invL.append(invariant_(ii, **kwargs))
    else:
        # Scatter DBF
        dbf_future = client.scatter(dbf, broadcast=True)
        kwargs['dbf'] = dbf_future
        try:
            A = client.map(invariant_, range(neq), **kwargs)
            invL = client.gather(A)
        except Exception as e:
             logging.error(f"Invariant Dask failed: {e}")
             kwargs.pop('dbf', None)
             invL = []
             for ii in range(neq):
                invL.append(invariant_(ii, dbf=dbf, **kwargs))

    Tv = np.zeros((neq,))
    phv = neq*[None]
    bndv = np.zeros((neq, 3))
    for ii in range(neq):
        Tv[ii] = invL[ii][0]
        phv[ii] = invL[ii][1]
        bndv[ii, :] = invL[ii][2]

    return Tv, phv, bndv

def invariant_(index, dbf, params, comps, phases, X, P, Tl, Tu, comp, symbols_to_fit, eq_callables, paramA=None):
    if paramA is None: paramA = params[index, :]
    
    kwargs = {'dbf': dbf, 'comps': comps, 'phases': phases,
              'paramA': paramA, 'symbols_to_fit': symbols_to_fit,
              'eq_callables': eq_callables}

    def mini(T):
        conds = {v.P: P, v.T: T, v.X(comp): X}
        eq = eq_calc_(conds=conds, **kwargs)
        PhT = list(np.unique(eq.Phase))
        if '' in PhT: PhT.remove('')
        return eq, PhT

    Tm = 0.5*(Tl+Tu)
    eql, PhTl = mini(Tl)
    eqm, PhTm = mini(Tm)
    equ, PhTu = mini(Tu)

    errlim = 0.01
    niter = int(np.ceil(np.log(errlim/(Tu-Tl))/np.log(0.5) - 1)) if (Tu-Tl) > 0 else 0

    for ii in range(niter):
        if str(PhTm) != str(PhTl):
            Tu = Tm
            equ = eqm
            PhTu = PhTm
        else:
            Tl = Tm
            eql = eqm
            PhTl = PhTm
        Tm = 0.5*(Tl + Tu)
        eqm, PhTm = mini(Tm)

    def getbnd(eq, PhT):
        bnd = []
        for phase in PhT:
            tmp = eq.X.where(eq.Phase == phase)
            tmp = tmp.sel(component=comp).sum(dim='vertex')
            bnd.append(np.squeeze(tmp.values))
        return np.array(bnd)

    PhTA = np.array(PhTl + PhTu)
    bndA = np.concatenate([getbnd(eql, PhTl), getbnd(equ, PhTu)])
    
    # Filter out empty phases and ensure bndA matches
    valid_indices = [i for i, p in enumerate(PhTA) if p and str(p) != 'None' and str(p) != '']
    PhTA = PhTA[valid_indices]
    bndA = bndA[valid_indices]
    
    phs, indx = np.unique(PhTA, return_index=True)
    bnd = bndA[indx]

    indx = np.argsort(bnd)
    phs = list(phs[indx])
    bnd = bnd[indx]

    logging.info(f'Invariant computed for set {index}: T = {Tm} +/- {Tm-Tl}K')
    return Tm, phs, bnd, index

# --- Plotting Functions ---

sns.set_theme(color_codes=True)

def get_label(cplt):
    label = cplt
    if cplt == 'T': label += ' (K)'
    elif cplt == 'P': label += ' (Pa)'
    return label

def get_phase_prob(eq, phaseregL):
    phsum = np.zeros(eq.NP.shape[:-1])
    phpres = np.ones(eq.NP.shape[:-1])
    for phase in phaseregL:
        NP_ = eq.NP.where(eq.Phase == phase)
        NP_ = NP_.sum(dim='vertex')
        phsum += NP_
        phpres *= NP_ > 0
    ineq = (phsum > 1 - 1e-6)*phpres
    prob = np.mean(ineq, 0)
    return prob

def get_ticks(eq, cplt):
    ticvalall = eq.get(cplt).values
    if cplt == 'T' or cplt == 'P':
        ticvalall = np.round(ticvalall, 0)
    else:
        ticvalall = np.round(ticvalall, 2)
    ntic = len(ticvalall)
    if ntic > 6:
        ticpts = np.arange(0, ntic, np.int32(np.floor(ntic/6)))
    else:
        ticpts = np.arange(ntic)
    ticvals = ticvalall[ticpts]
    return ticpts, ticvals

def plot_dist(eq, coordD, phaseregL, phase, typ, figsize=None, ax=None):
    if coordD:
        coordD = {str(k): v for k, v in coordD.items()}
    compL = np.array([])
    # Safely filter coordD to only include valid dimensions/coordinates for eq
    sel_coordD = {k: v for k, v in coordD.items() if k in eq.dims or k in eq.coords}
    
    for ii in range(eq.sizes['sample']):
        eq_ = eq.sel({'sample': ii}).sel(sel_coordD)
        phaseregL_ = list(np.squeeze(eq_.Phase.values))
        # Remove ALL empty strings and 'None'
        phaseregL_ = [p for p in phaseregL_ if p and str(p) != 'None' and str(p) != '']
        phaseregL_copy = list(phaseregL)
        phaseregL_copy.sort()
        phaseregL_.sort()

        if phaseregL_copy == phaseregL_:
            val = eq_[typ].where(eq_.Phase == phase)
            val = val.sum(dim='vertex').values
            if val.size == 1: val = val.item()
            else: val = val[0]
            compL = np.append(compL, val)

    if ax is None:
        fig = Figure(figsize=figsize)
        ax = fig.subplots()
    else:
        fig = ax.figure
    if len(compL) > 0:
        if np.all(compL == compL[0]):
            # All values are identical, plot a single bar
            ax.axvline(compL[0], color='blue', linewidth=2)
            ax.set_xlim(compL[0] - 0.05, compL[0] + 0.05)
            ax.text(compL[0], 0.5, f'All values = {compL[0]:.4g}', ha='center', va='bottom', rotation=90, transform=ax.get_xaxis_transform())
        else:
            sns.histplot(compL, stat='density', kde=True, ax=ax)
    else:
        ax.text(0.5, 0.5, 'No data for this phase region', ha='center', va='center')
        
    xlabeld = {'NP': '%s phase fraction' % phase,
               'X': r'$\mathrm{x_{%s}}$' % coordD.get('component', 'Comp'),
               'GM': 'Molar Gibbs energy',
               'MU': 'chemical potential, %s' % coordD.get('component', 'Comp')}
    ax.set_xlabel(xlabeld.get(typ, typ), fontsize='large')
    ax.set_ylabel('frequency', fontsize='large')
    ax.grid(True)
    fig.tight_layout()
    return fig, compL

def _plot_phase_property_fixed_comp(dbf, comps, phases, conds, params, prop, coordD, xlabel=None, ylabel=None, yscale=None, xlim=None, figsize=None, ax=None, cdict=None, act_comp=None):
    """
    Dedicated to phase property uncertainty calculation and plotting when composition is fixed (temperature is independent variable).
    Completely isolated from the fixed-temperature code, no mutual interference.
    """
    # Extract temperature, pressure and fixed composition
    T = 1000
    P = 101325
    fixed_points = {} # Store fixed composition, e.g., {'SI': 0.5}
    for k, v_ in conds.items():
        if k == v.T: T = v_
        elif k == v.P: P = v_
        elif k != v.T and k != v.P and k != v.N:
            if hasattr(k, 'species'):
                fixed_points[k.species.name] = v_
            elif hasattr(k, 'name') and k.name == 'X':
                fixed_points[k.species.name] = v_
            elif str(k).startswith('X('):
                fixed_points[str(k)[2:-1]] = v_

    # Independent variable is temperature
    xvec = np.atleast_1d(T)

    # Handle property mapping
    target_prop = prop
    is_mixing = prop in ['GM_MIX', 'HM_MIX', 'SM_MIX']
    if is_mixing:
        target_prop = prop.split('_')[0]
    if prop == 'ACR':
        target_prop = 'MU'

    if ax is None:
        fig = Figure(figsize=figsize)
        ax = fig.subplots()
    else:
        fig = ax.figure

    # Pre-calculate pure component reference state energy (if mixing property)
    ref_energies = {} # {sample_idx: {comp_name: array_of_energies}}
    
    # Get parameter names according to user script logic, ensure order matches engine_analysis.py
    v_symbols = database_symbols_to_fit(dbf)

    if is_mixing:
        logging.info(f"Pre-calculating reference energies for {prop} (Fixed Composition)...")
        for jj in range(params.shape[0]):
            param_dict = {sym: float(val) for sym, val in zip(v_symbols, params[jj, :])}
            ref_energies[jj] = {}
            for comp_name in comps:
                if comp_name == 'VA': continue
                try:
                    res_ref = calculate(dbf, comps, phases, T=T, P=P, output=target_prop, parameters=param_dict, 
                                      **{f'X_{comp_name}': 1.0})
                    # Find all dimensions except temperature (T) and collapse minimum, ensuring lowest energy of pure component at each temperature
                    dims_to_reduce = [d for d in res_ref[target_prop].dims if d != 'T']
                    if dims_to_reduce:
                        ref_vals = res_ref[target_prop].min(dim=dims_to_reduce).values.squeeze()
                    else:
                        ref_vals = res_ref[target_prop].values.squeeze()
                        
                    if hasattr(ref_vals, 'size') and ref_vals.size == len(xvec):
                        ref_energies[jj][comp_name] = ref_vals
                    else:
                        ref_energies[jj][comp_name] = np.full_like(xvec, ref_vals)
                except Exception as e:
                    logging.warning(f"Failed to calculate reference for {comp_name}: {e}")
                    ref_energies[jj][comp_name] = np.zeros_like(xvec)

    colorL = sns.color_palette("husl", len(phases))

    for ii, phase in enumerate(phases):
        all_vals = []
        for jj in range(params.shape[0]):
            param_dict = {sym: float(val) for sym, val in zip(v_symbols, params[jj, :])}
            try:
                if prop == 'ACR':
                    a_comp = act_comp
                    if not a_comp:
                        for c in comps:
                            if c != 'VA':
                                a_comp = c
                                break
                    
                    R_ACR = 8.314
                    y_vals = []
                    for t_val in xvec:
                        try:
                            conds_eq = {v.P: P, v.T: t_val}
                            for comp_name, comp_val in conds.items():
                                c_name = getattr(comp_name, 'name', str(comp_name))
                                if c_name not in ['T', 'P', 'N']:
                                    conds_eq[comp_name] = comp_val
                            
                            try:
                                res = equilibrium(dbf, comps, [phase], conds_eq, parameters=param_dict)
                            except ValueError:
                                indep_comps = [c for c in comps if c != 'VA']
                                current_x_comp = next((k for k in conds_eq.keys() if getattr(k, 'name', str(k)) not in ['T', 'P', 'N']), None)
                                if current_x_comp:
                                    if hasattr(current_x_comp, 'species'):
                                        c_name = current_x_comp.species.name
                                    elif str(current_x_comp).startswith('X('):
                                        c_name = str(current_x_comp)[2:-1]
                                    else:
                                        c_name = None
                                        
                                    if c_name:
                                        other_c = next((c for c in indep_comps if c != c_name), None)
                                        if other_c:
                                            conds_eq_new = {v.P: P, v.T: t_val, v.X(other_c): 1.0 - conds_eq[current_x_comp]}
                                            res = equilibrium(dbf, comps, [phase], conds_eq_new, parameters=param_dict)
                                        else:
                                            raise
                                    else:
                                        raise
                                else:
                                    raise

                            # Robustly get chemical potential
                            if 'component' in res.dims:
                                available_comps = [str(c) for c in res.component.values]
                                target_c = a_comp
                                if target_c not in available_comps:
                                    if target_c.upper() in available_comps:
                                        target_c = target_c.upper()
                                    else:
                                        for c in available_comps:
                                            if c.upper() == target_c.upper():
                                                target_c = c
                                                break
                                if target_c in available_comps:
                                    mu = float(res.MU.sel(component=target_c).values.flatten()[0])
                                else:
                                    mu = float(res.MU.isel(component=0).values.flatten()[0])
                            else:
                                mu = float(res.MU.values.flatten()[0])
                                
                            try:
                                ref_conds = {v.P: P, v.T: t_val, v.X(a_comp): 0.999}
                                res_ref = equilibrium(dbf, comps, [phase], ref_conds, parameters=param_dict)
                            except ValueError:
                                other_comp = next((c for c in comps if c != 'VA' and c != a_comp), None)
                                if other_comp:
                                    ref_conds = {v.P: P, v.T: t_val, v.X(other_comp): 0.001}
                                    res_ref = equilibrium(dbf, comps, [phase], ref_conds, parameters=param_dict)
                                else:
                                    raise
                            
                            if 'component' in res_ref.dims:
                                available_comps_ref = [str(c) for c in res_ref.component.values]
                                target_c_ref = a_comp
                                if target_c_ref not in available_comps_ref:
                                    if target_c_ref.upper() in available_comps_ref:
                                        target_c_ref = target_c_ref.upper()
                                    else:
                                        for c in available_comps_ref:
                                            if c.upper() == target_c_ref.upper():
                                                target_c_ref = c
                                                break
                                if target_c_ref in available_comps_ref:
                                    mu0_v = float(res_ref.MU.sel(component=target_c_ref).values.flatten()[0])
                                else:
                                    mu0_v = float(res_ref.MU.isel(component=0).values.flatten()[0])
                            else:
                                mu0_v = float(res_ref.MU.values.flatten()[0])
                                
                            a = np.exp((mu - mu0_v) / (R_ACR * t_val))
                            y_vals.append(a)
                        except Exception as e:
                            logging.warning(f"Failed to calculate ACR for {a_comp} at T={t_val}: {e}")
                            y_vals.append(np.nan)
                    
                    y_vals = np.array(y_vals)
                else:
                    res = calculate(dbf, comps, phase, T=T, P=P, 
                                    output=target_prop, 
                                    parameters=param_dict)
                    
                    # Handle component dimension for MU/ACR
                    if target_prop == 'MU' and 'component' in res.dims:
                        available_comps = [str(c) for c in res.component.values]
                        target_c = a_comp
                        if target_c and target_c not in available_comps:
                            if target_c.upper() in available_comps:
                                target_c = target_c.upper()
                            else:
                                for c in available_comps:
                                    if c.upper() == target_c.upper():
                                        target_c = c
                                        break
                        
                        if target_c in available_comps:
                            y_vals_raw = res[target_prop].sel(component=target_c).values.squeeze()
                        else:
                            y_vals_raw = res[target_prop].isel(component=0).values.squeeze()
                    else:
                        y_vals_raw = res[target_prop].values.squeeze()

                    # Handle internal degrees of freedom
                    if hasattr(y_vals_raw, 'ndim') and y_vals_raw.ndim > 1:
                        # Find the index of minimum energy
                        min_idx = np.nanargmin(y_vals_raw, axis=-1)
                        # Extract minimum energy
                        y_vals = np.nanmin(y_vals_raw, axis=-1)
                    else:
                        y_vals = y_vals_raw
                    
                    # If mixing property, subtract reference state energy
                    if is_mixing:
                        if hasattr(y_vals_raw, 'ndim') and y_vals_raw.ndim > 1:
                            for comp_name in comps:
                                if comp_name == 'VA': continue
                                if comp_name in res.component.values:
                                    x_i_raw = res.X.sel(component=comp_name).values.squeeze()
                                    # Extract composition corresponding to minimum energy
                                    if x_i_raw.ndim > 1:
                                        x_i = np.array([x_i_raw[i, min_idx[i]] for i in range(len(min_idx))])
                                    else:
                                        x_i = x_i_raw
                                    ref_i = ref_energies[jj].get(comp_name, np.zeros_like(y_vals))
                                    y_vals = y_vals - x_i * ref_i
                        else:
                            for comp_name in comps:
                                if comp_name == 'VA': continue
                                if comp_name in res.component.values:
                                    x_i = res.X.sel(component=comp_name).values.squeeze()
                                    ref_i = ref_energies[jj].get(comp_name, np.zeros_like(y_vals))
                                    y_vals = y_vals - x_i * ref_i

                # Ensure consistent lengths
                if hasattr(y_vals, 'size') and y_vals.size == len(xvec):
                    all_vals.append(y_vals)
                else:
                    all_vals.append(np.full_like(xvec, y_vals))
            except Exception as e:
                logging.warning(f"Failed to calculate for phase {phase} in sample {jj}: {e}")
                all_vals.append(np.full_like(xvec, np.nan))
        
        val_arr = np.array(all_vals) # (samples, steps)
        
        if yscale is not None:
            val_arr = val_arr * yscale
            
        color = cdict.get(phase, colorL[ii]) if cdict else colorL[ii]
        
        if prop == 'ACR':
            # According to user designed statistics: Mean +/- 2*Std
            # Use masked_invalid to handle NaN
            val_arr_masked = np.ma.masked_invalid(val_arr)
            mean_val = np.mean(val_arr_masked, axis=0)
            std_val = np.std(val_arr_masked, axis=0)
            
            ax.fill_between(xvec, mean_val - 2*std_val, mean_val + 2*std_val, color=color, alpha=0.2, label=f'95% Confidence ({phase})')
            ax.plot(xvec, mean_val, color=color, lw=2, label=f'Mean Activity of {act_comp} ({phase})')
        else:
            low, mid, high = np.nanpercentile(val_arr, [0, 50, 100], axis=0)
            ax.plot(xvec, mid, linestyle='-', color=color, label=phase)
            ax.fill_between(xvec, low, high, alpha=0.2, facecolor=color)

    if prop == 'ACR':
        if not ylabel: ylabel = 'Activity'
        if not xlabel: xlabel = 'Temperature (K)'
        # Activity variation with temperature is not necessarily 0-1 range, but can set a reasonable bound
        ax.set_ylim(0, 1.2)

    ax.set_xlabel(xlabel if xlabel else 'Temperature (K)')
    if ylabel:
        ax.set_ylabel(ylabel)
    if xlim:
        ax.set_xlim(xlim)
    ax.set_box_aspect(1)
    ax.grid(True)
    ax.legend()
    
    return fig

def plot_phase_property(dbf, comps, phases, conds, params, prop, coordD, xlabel=None, ylabel=None, yscale=None, xlim=None, figsize=None, ax=None, cdict=None, act_comp=None):
    """
    Calculate and plot property uncertainty for each phase.
    If pduq library is available, prefer its plot_property function to ensure consistency with local scripts.
    """
    # Extract temperature and pressure
    T = 1000
    P = 101325
    for k, v_ in conds.items():
        if k == v.T: T = v_
        elif k == v.P: P = v_

    # Determine if fixed composition (temperature is independent variable)
    is_fixed_comp = False
    for k, v_ in conds.items():
        if k == v.T and isinstance(v_, (list, tuple, np.ndarray)) and len(np.atleast_1d(v_)) > 1:
            is_fixed_comp = True
            break
            
    # If fixed composition, use dedicated function, completely unaffected fixed-temperature code
    if is_fixed_comp:
        return _plot_phase_property_fixed_comp(dbf, comps, phases, conds, params, prop, coordD, xlabel, ylabel, yscale, xlim, figsize, ax, cdict, act_comp=act_comp)
    
    if HAS_PDUQ_PLOT and prop != 'ACR':
        # Remove parameters P, x_comp, CI not supported by library function (based on error message)
        # Try to match user provided script call format, ensure consistent calculation logic
        
        # If no ax passed, create one first, so even if library function doesn't return fig, we have a reference
        if ax is None:
            fig = Figure(figsize=figsize) if figsize else Figure()
            ax = fig.subplots()
        else:
            fig = ax.get_figure()

        kwargs = {
            'xlabel': xlabel,
            'ylabel': ylabel,
            'xlim': xlim,
            'yscale': yscale,
            'figsize': figsize
        }
        # Filter out None values
        kwargs = {k: v for k, v in kwargs.items() if v is not None}
        
        res_fig = pduq_plot_property(dbf, comps, phases, params, T, prop, **kwargs)
        
        # If library function returns a new Figure, update reference
        if res_fig is not None:
            fig = res_fig
            ax = fig.gca()
        else:
            # If library function didn't return Figure, try to get from current active figure
            fig = plt.gcf()
            ax = fig.gca()
        
        # Apply ARCTDE style
        ax.set_box_aspect(1)
        ax.grid(True)
        # Ensure legend is displayed
        ax.legend()
        
        return fig

    # Fallback to manual implementation (if pduq is unavailable)
    if coordD:
        coordD = {str(k): v for k, v in coordD.items()}
    
    # Automatically infer independent variable dimension
    xvec = None
    vary_var = None
    for k, v_ in conds.items():
        if isinstance(v_, (list, np.ndarray)) and len(v_) > 1:
            xvec = v_
            vary_var = k
            break

    if xvec is None:
        for k, v_ in conds.items():
            if not isinstance(v_, (list, np.ndarray)):
                xvec = np.array([v_])
                vary_var = k
                break

    # Extract fixed temperature and pressure (if array, take first value as default)
    T_fixed = 1000
    P_fixed = 101325
    for k, v_ in conds.items():
        if k == v.T and not isinstance(v_, (list, np.ndarray)): T_fixed = v_
        elif k == v.P and not isinstance(v_, (list, np.ndarray)): P_fixed = v_

    # Identify independent variable component
    x_comp = None
    for k in conds.keys():
        # More robust identification logic
        k_name = getattr(k, 'name', str(k))
        if k_name == 'X':
            if hasattr(k, 'species'):
                x_comp = k.species.name
                break
        elif k_name.startswith('X('):
            # Extract from string, e.g. 'X(SI)' -> 'SI'
            if '(' in k_name and ')' in k_name:
                x_comp = k_name[k_name.find('(')+1:k_name.find(')')]
                break
        elif hasattr(k, 'species') and k_name not in ['T', 'P', 'N']:
            x_comp = k.species.name
            break
    
    logging.info(f"plot_phase_property: identified x_comp={x_comp} from conds.keys={[str(k) for k in conds.keys()]}")
            
    # Extract fixed components
    X_fixed = 0.5
    if x_comp:
        for k, v_ in conds.items():
            if k != v.T and k != v.P and k != v.N and not isinstance(v_, (list, np.ndarray)):
                X_fixed = v_
                break
    
    if xvec is None:
        xvec = np.linspace(0, 1, 101)

    # Handle property mapping
    target_prop = prop
    if prop in ['GM_MIX', 'HM_MIX', 'SM_MIX']:
        target_prop = prop.split('_')[0]
    if prop == 'ACR':
        target_prop = 'MU'

    CI = 95
    if ax is None:
        fig = Figure(figsize=figsize)
        ax = fig.subplots()
    else:
        fig = ax.figure

    colorL = sns.color_palette("husl", len(phases))

    # Identify activity component
    if act_comp is None:
        act_comp = x_comp

    # Get parameter names according to user script logic, ensure order matches engine_analysis.py
    v_symbols = database_symbols_to_fit(dbf)

    for ii, phase in enumerate(phases):
        all_vals = []
        # Calculate for each sample
        for jj in range(params.shape[0]):
            param_dict = {sym: float(val) for sym, val in zip(v_symbols, params[jj, :])}
            try:
                if prop == 'ACR':
                    # Use equilibrium to calculate activity, match user script logic
                    R_ACR = 8.314
                    y_vals = []
                    
                    # If x_comp is still None, try to find any component variable from conds
                    if not x_comp:
                        for k in conds.keys():
                            k_name = getattr(k, 'name', str(k))
                            if k_name == 'X' or k_name.startswith('X('):
                                if hasattr(k, 'species'): x_comp = k.species.name
                                else:
                                    s_k = str(k)
                                    if '(' in s_k and ')' in s_k: x_comp = s_k[s_k.find('(')+1:s_k.find(')')]
                                if x_comp: break
                    
                    for x_val in xvec:
                        try:
                            # Build calculation condition for current point
                            cur_vary_name = getattr(vary_var, 'name', str(vary_var))
                            if cur_vary_name == 'T':
                                current_T = x_val
                                current_X = X_fixed
                            else:
                                current_T = T_fixed
                                current_X = x_val
                            
                            # Calculate current state
                            try:
                                if x_comp:
                                    conds_eq = {v.P: P_fixed, v.T: current_T, v.X(x_comp): current_X}
                                else:
                                    # If no component variable, might be a pure component system or there is an issue
                                    conds_eq = {v.P: P_fixed, v.T: current_T}
                                
                                res = equilibrium(dbf, comps, [phase], conds_eq, parameters=param_dict)
                            except ValueError:
                                # If x_comp is dependent component, try to set another component with 1 - current_X
                                other_comp = next((c for c in comps if c != 'VA' and c != x_comp), None)
                                if other_comp:
                                    conds_eq = {v.P: P_fixed, v.T: current_T, v.X(other_comp): 1.0 - current_X}
                                    res = equilibrium(dbf, comps, [phase], conds_eq, parameters=param_dict)
                                else:
                                    raise
                            
                            if 'component' in res.dims:
                                available_comps = [str(c) for c in res.component.values]
                                target_c = act_comp
                                if target_c not in available_comps:
                                    if target_c.upper() in available_comps:
                                        target_c = target_c.upper()
                                    else:
                                        for c in available_comps:
                                            if c.upper() == target_c.upper():
                                                target_c = c
                                                break
                                if target_c in available_comps:
                                    mu = float(res.MU.sel(component=target_c).values.flatten()[0])
                                else:
                                    mu = float(res.MU.isel(component=0).values.flatten()[0])
                            else:
                                mu = float(res.MU.values.flatten()[0])
                            
                            # Calculate reference state (pure component)
                            try:
                                ref_conds = {v.P: P_fixed, v.T: current_T, v.X(act_comp): 0.999}
                                res_ref = equilibrium(dbf, comps, [phase], ref_conds, parameters=param_dict)
                            except ValueError:
                                other_comp = next((c for c in comps if c != 'VA' and c != act_comp), None)
                                if other_comp:
                                    ref_conds = {v.P: P_fixed, v.T: current_T, v.X(other_comp): 0.001}
                                    res_ref = equilibrium(dbf, comps, [phase], ref_conds, parameters=param_dict)
                                else:
                                    raise
                            
                            if 'component' in res_ref.dims:
                                available_comps_ref = [str(c) for c in res_ref.component.values]
                                target_c_ref = act_comp
                                if target_c_ref not in available_comps_ref:
                                    if target_c_ref.upper() in available_comps_ref:
                                        target_c_ref = target_c_ref.upper()
                                    else:
                                        for c in available_comps_ref:
                                            if c.upper() == target_c_ref.upper():
                                                target_c_ref = c
                                                break
                                if target_c_ref in available_comps_ref:
                                    mu0 = float(res_ref.MU.sel(component=target_c_ref).values.flatten()[0])
                                else:
                                    mu0 = float(res_ref.MU.isel(component=0).values.flatten()[0])
                            else:
                                mu0 = float(res_ref.MU.values.flatten()[0])
                            
                            # Calculate activity
                            activity = np.exp((mu - mu0) / (R_ACR * current_T))
                            if jj == 0 and len(y_vals) < 5:
                                logging.info(f"ACR Sample 0, point {len(y_vals)}: mu={mu}, mu0={mu0}, T={current_T}, act={activity}, conds={conds_eq}, ref_conds={ref_conds}")
                            y_vals.append(activity)
                            
                        except Exception as e:
                            import traceback
                            logging.warning(f"Failed to calculate ACR for {act_comp} at point={x_val}: {e}\n{traceback.format_exc()}")
                            y_vals.append(np.nan)
                    
                    all_vals.append(np.array(y_vals))
                else:
                    # Use calculate to get property of this phase
                    res = calculate(dbf, comps, phase, T=T, P=P, output=target_prop, parameters=param_dict)
                    
                    y_vals = res[target_prop].values.squeeze()
                    
                    # Handle component dimension for MU/ACR
                    if target_prop == 'MU' and 'component' in res.dims:
                        available_comps = [str(c) for c in res.component.values]
                        target_c = act_comp
                        if target_c and target_c not in available_comps:
                            if target_c.upper() in available_comps:
                                target_c = target_c.upper()
                            else:
                                for c in available_comps:
                                    if c.upper() == target_c.upper():
                                        target_c = c
                                        break
                        
                        if target_c in available_comps:
                            y_vals = res[target_prop].sel(component=target_c).values.squeeze()
                        elif x_comp and str(x_comp) in available_comps:
                            y_vals = res[target_prop].sel(component=str(x_comp)).values.squeeze()
                        else:
                            y_vals = res[target_prop].isel(component=0).values.squeeze()

                    # If activity ACR, need to calculate reference state and exponentiate (this branch usually entered when vary='T')
                    if prop == 'ACR':
                        R_ACR = 8.314
                        if act_comp:
                            ref_conds = {v.P: 101325, v.T: T, v.X(act_comp): 0.999}
                            res_ref = equilibrium(dbf, comps, [phase], ref_conds, parameters=param_dict)
                            if 'component' in res_ref.dims:
                                mu0 = float(res_ref.MU.sel(component=act_comp).values.flatten()[0])
                            else:
                                mu0 = float(res_ref.MU.values.flatten()[0])
                            y_vals = np.exp((y_vals - mu0) / (R_ACR * T))
                        else:
                            y_vals = np.ones_like(y_vals)

                    # Map to xvec
                    if x_comp and x_comp in res.component.values:
                        x_vals = res.X.sel(component=x_comp).values.squeeze()
                        if np.atleast_1d(x_vals).size > 1:
                            idx = np.argsort(x_vals)
                            y_interp = np.interp(xvec, x_vals[idx], y_vals[idx], left=np.nan, right=np.nan)
                            all_vals.append(y_interp)
                        else:
                            all_vals.append(np.full_like(xvec, y_vals))
                    else:
                        all_vals.append(np.full_like(xvec, y_vals))
            except Exception as e:
                logging.warning(f"Failed to calculate for phase {phase} in sample {jj}: {e}")
                all_vals.append(np.full_like(xvec, np.nan))
        
        val_arr = np.array(all_vals) # (samples, steps)
        
        if yscale is not None:
            val_arr = val_arr * yscale
            
        color = cdict.get(phase, colorL[ii]) if cdict else colorL[ii]
        
        if prop == 'ACR':
            # According to user designed statistics: Mean +/- 2*Std
            # Use masked_invalid to handle NaN
            val_arr_masked = np.ma.masked_invalid(val_arr)
            mean_val = np.mean(val_arr_masked, axis=0)
            std_val = np.std(val_arr_masked, axis=0)
            
            ax.fill_between(xvec, mean_val - 2*std_val, mean_val + 2*std_val, color=color, alpha=0.2, label=f'95% Confidence ({phase})')
            ax.plot(xvec, mean_val, color=color, lw=2, label=f'Mean Activity of {act_comp} ({phase})')
        else:
            # Use full sample bounds (0% to 100%) instead of fixed confidence interval
            low, mid, high = np.nanpercentile(val_arr, [0, 50, 100], axis=0)
            ax.plot(xvec, mid, linestyle='-', color=color, label=phase)
            ax.fill_between(xvec, low, high, alpha=0.2, facecolor=color)

    if prop == 'ACR':
        # Add ideal solution line (Raoult's Law)
        ax.plot([0, 1], [0, 1], 'k--', label="Ideal (Raoult's Law)")
        if not ylabel or 'Activity' in ylabel: 
            ylabel = f'Activity $a_{{{act_comp}}}$' if act_comp else 'Activity'
        if not xlabel: xlabel = f'Mole Fraction $X_{{{x_comp}}}$' if x_comp else 'Mole Fraction'
        ax.set_xlim(0, 1)
        ax.set_ylim(0, 1.2)
        title_prefix = "System" if len(phases) > 1 else phases[0]
        ax.set_title(f'{title_prefix} Activity Uncertainty ({T}K)')

    if xlabel: ax.set_xlabel(xlabel)
    if ylabel: ax.set_ylabel(ylabel)
    if xlim: ax.set_xlim(xlim)
    ax.legend()
    return fig

def plot_property(eq, prop, coordD, xlabel=None, ylabel=None, yscale=None, xlim=None, datasets=None, comps=None, figsize=None, ax=None, color='#2c7bb6', label='System Equilibrium', mu0=None, T=1000, x_comp=None, act_comp=None):
    """
    Follow correct UQ propagation logic: calculated eq (including equilibrium system properties) is directly used for statistics and plotting.
    """
    if coordD:
        coordD = {str(k): v for k, v in coordD.items()}
    eq_sel = eq.sel(coordD) if coordD else eq
    
    # Automatically infer independent variable dimension (Usually T or X_...)
    rmlist = ['N', 'internal_dof', 'sample', 'vertex']
    max_sz = 0
    dim_max = None
    for dim in list(eq_sel.dims):
        if dim not in rmlist:
            dim_sz = eq_sel.sizes[dim]
            if dim_sz > max_sz:
                max_sz = dim_sz
                dim_max = dim
                
    if dim_max is None: 
        logger.error("Could not find independent variable dimension in eq dataset.")
        return None
        
    xvec = eq_sel.get(dim_max).values
    CI = 95
    
    if ax is None:
        fig = Figure(figsize=figsize)
        ax = fig.subplots()
    else:
        fig = ax.figure

    # Handle property mapping (PyCalphad equilibrium defaults include GM, HM, SM, MU)
    target_prop = prop
    if prop in ['GM_MIX', 'HM_MIX', 'SM_MIX']:
        target_prop = prop.split('_')[0]
    if prop == 'ACR':
        target_prop = 'MU' # Approximate/directly show using chemical potential, strict activity requires pure component reference state
        
    if target_prop not in eq_sel:
        logger.warning(f"Property {target_prop} not found in eq dataset. Defaulting to GM.")
        target_prop = 'GM'
        
    val = eq_sel[target_prop].values
    
    # Identify activity component
    if act_comp is None:
        act_comp = x_comp

    # If chemical potential MU, usually one more component dimension
    if target_prop == 'MU' and 'component' in eq_sel.dims:
        if act_comp and act_comp in eq_sel.component.values:
            val = eq_sel[target_prop].sel(component=act_comp).values
        elif x_comp and x_comp in eq_sel.component.values:
            val = eq_sel[target_prop].sel(component=x_comp).values
        else:
            val = eq_sel[target_prop].isel(component=0).values

    val = np.squeeze(val)
    
    # Ensure val shape is (samples, steps)
    if val.ndim == 2:
        if val.shape[0] == len(xvec) and val.shape[1] == eq_sel.sizes.get('sample', 0):
            val = val.T
            
    # If activity ACR, need to calculate reference state and exponentiate
    if prop == 'ACR':
        if mu0 is not None:
            # According to user script, use R = 8.314
            R_ACR = 8.314
            # mu0 should be an array, length equals sample count
            mu0 = np.atleast_1d(mu0)
            
            # Determine value of T, if changing with temperature, use xvec
            T_vals = T
            if dim_max == 'T':
                T_vals = xvec
                
            if len(mu0) == val.shape[0]:
                # val shape is (samples, steps)
                # T_vals shape is (steps,) or scalar
                val = np.exp((val - mu0[:, np.newaxis]) / (R_ACR * T_vals))
            else:
                logger.warning(f"mu0 length {len(mu0)} does not match samples {val.shape[0]}. Skipping activity calculation.")
        else:
            logger.warning("mu0 not provided for ACR. Plotting MU instead.")

    if yscale is not None:
        val = val * yscale
        
    if prop == 'ACR' and mu0 is not None:
        # According to user designed statistics: Mean +/- 2*Std
        # Use masked_invalid to handle NaN
        val_masked = np.ma.masked_invalid(val)
        mean_val = np.mean(val_masked, axis=0)
        std_val = np.std(val_masked, axis=0)
        
        ax.fill_between(xvec, mean_val - 2*std_val, mean_val + 2*std_val, color=color, alpha=0.2, label=f'95% Confidence ({label})')
        ax.plot(xvec, mean_val, color=color, lw=2, label=f'Mean Activity of {act_comp}')
        
        # Add ideal solution line (Raoult's Law)
        ax.plot([0, 1], [0, 1], 'k--', label="Ideal (Raoult's Law)")
        if not ylabel or 'Activity' in ylabel: 
            ylabel = f'Activity $a_{{{act_comp}}}$' if act_comp else 'Activity'
        if not xlabel: xlabel = f'Mole Fraction $X_{{{x_comp}}}$' if x_comp else 'Mole Fraction'
        ax.set_xlim(0, 1)
        ax.set_ylim(0, 1.2)
        ax.set_title(f'System Activity Uncertainty ({T}K)')
    else:
        # Calculate full sample bounds (0% to 100%) on sample dimension (axis=0)
        low, mid, high = np.nanpercentile(val, [0, 50, 100], axis=0)
        
        ax.plot(xvec, mid, linestyle='-', color=color, label=label)
        ax.fill_between(np.atleast_1d(xvec), low, high, alpha=0.3, facecolor=color)
    
    # Experimental data layer
    if datasets:
        try:
            from espei.datasets import filter_datasets, recursive_glob
            if isinstance(datasets, str) and os.path.isdir(datasets):
                from espei.datasets import load_datasets
                datasets = load_datasets(recursive_glob(datasets, '*.json'))
                
            espei_prop_map = {'GM': 'GM', 'HM': 'HM', 'SM': 'SM', 'CPM': 'CPM', 'HM_MIX': 'HM_MIX', 'GM_MIX': 'GM_MIX', 'SM_MIX': 'SM_MIX', 'ACR': 'ACR'}
            output_prop = espei_prop_map.get(prop, prop)
            
            if comps:
                filtered_ds = filter_datasets(datasets, components=comps, output=output_prop)
                for ds in filtered_ds:
                    conds = ds.get('conditions', {})
                    T_ds = np.atleast_1d(conds.get('T', []))
                    X_ds_dict = conds.get('X', {})
                    values = np.array(ds.get('values')).squeeze()
                    
                    x_comp_ds = None
                    if X_ds_dict:
                        for k, v in X_ds_dict.items():
                            if len(np.atleast_1d(v)) > 1:
                                x_comp_ds = k
                                break
                        if not x_comp_ds:
                            x_comp_ds = list(X_ds_dict.keys())[0]
                            
                    if x_comp_ds:
                        X_exp = np.atleast_1d(X_ds_dict[x_comp_ds]).squeeze()
                    else:
                        X_exp = T_ds.squeeze()
                        
                    P_exp = values
                    if P_exp.ndim > 1:
                        P_exp = P_exp[0]
                    if yscale:
                        P_exp = P_exp * yscale
                        
                    if X_exp.size > 0 and P_exp.size > 0:
                        ax.plot(X_exp, P_exp, 'ro', label=f"Exp: {ds.get('reference', 'Unknown')}")
        except Exception as e:
            logger.warning(f"Error plotting datasets: {e}")

    if xlim: ax.set_xlim(xlim)
    else:
        x_min = np.min(xvec)
        x_max = np.max(xvec)
        if x_min == x_max:
            ax.set_xlim([x_min - 0.05, x_max + 0.05])
        else:
            ax.set_xlim([x_min, x_max])
            
    if xlabel: ax.set_xlabel(xlabel)
    if ylabel: ax.set_ylabel(ylabel)
    
    ax.grid(True)
    ax.legend()
    fig.tight_layout()
    return fig

def plot_binary(eq, comp, alpha=None, cdict=None, markersize=1, ax=None):
    if ax is None:
        fig = Figure()
        ax = fig.subplots()
    else:
        fig = ax.figure
    Tvec = eq.get('T').values
    Xvec = eq.get('X_' + comp).values
    phaseL = list(np.unique(eq.get('Phase').values))
    if '' in phaseL: phaseL.remove('')
    nph = len(phaseL)
    Xph = np.zeros((Tvec.size, Xvec.size, nph))

    for ii in range(nph):
        tmp = eq.X.where(eq.Phase == phaseL[ii])
        tmp = tmp.sel(component=comp)
        nans = np.squeeze(tmp.values)
        if nans.ndim > 2:
             nans = np.isnan(nans[..., 0])*np.isnan(nans[..., 1])
             Xph_ = np.squeeze(tmp.sum(dim='vertex').values)
        else:
             nans = np.isnan(nans)
             Xph_ = np.squeeze(tmp.values)
        Xph_[nans] = np.nan
        Xph[..., ii] = Xph_

    XphD = {}
    for ii in range(Tvec.size):
        T = str(np.int32(Tvec[ii]))
        xl, pl = 'X_' + T, 'Ph_' + T
        XphD[xl], XphD[pl] = [], []
        for jj in range(nph):
            neq2comp = np.isclose(Xph[ii, :, jj], Xvec, atol=1e-4)
            neq2comp = np.invert(neq2comp)
            vals = Xph[ii, neq2comp, jj]
            vals = vals[np.invert(np.isnan(vals))]
            vals_ = np.round(vals, 5)
            loc, indx = np.unique(vals_, return_index=True)
            vals = vals[indx]
            XphD[xl] += list(vals)
            XphD[pl] += len(vals)*[phaseL[jj]]
        if XphD[xl]:
            arg = np.argsort(np.array(XphD[xl]))
            XphD[xl] = np.array(XphD[xl])[arg]
            XphD[pl] = np.array(XphD[pl])[arg]

    colorL = sns.color_palette("cubehelix", nph)
    if alpha is None: alpha = 0.9

    for ii in range(Tvec.size):
        T = str(np.int32(Tvec[ii]))
        xl, pl = 'X_' + T, 'Ph_' + T
        vals = np.array(XphD[xl])
        phs = np.array(XphD[pl])
        if len(vals) == 0: continue
        for jj in range(nph):
            if phaseL[jj] not in list(phs): continue
            vals_ = vals[phs == phaseL[jj]]
            color = cdict.get(phaseL[jj], colorL[jj]) if cdict else colorL[jj]
            ax.plot(vals_, [Tvec[ii]]*len(vals_), marker='o', markersize=markersize, alpha=alpha, color=color, linestyle='', mew=0.0)
    return fig

def cluster_invariant_points(points, n_clusters=None):
    """
    Cluster invariant points using K-Means.
    If n_clusters is None, it will be automatically determined using the silhouette score.
    """
    if points.shape[0] < 2:
        return np.zeros(points.shape[0])
    
    # Standardize data
    scaler = StandardScaler()
    points_scaled = scaler.fit_transform(points)
    
    if n_clusters is None or n_clusters == '':
        # Automatically determine n_clusters (max 5 or points.shape[0]-1)
        max_clusters = min(5, points.shape[0] - 1)
        if max_clusters < 2:
            n_clusters = 1
        else:
            best_score = -1
            best_n = 1
            for n in range(2, max_clusters + 1):
                kmeans = KMeans(n_clusters=n, n_init=10, random_state=42)
                labels = kmeans.fit_predict(points_scaled)
                score = silhouette_score(points_scaled, labels)
                if score > best_score:
                    best_score = score
                    best_n = n
            n_clusters = best_n
    else:
        try:
            n_clusters = int(n_clusters)
        except (ValueError, TypeError):
            # Fallback to 1 if invalid
            n_clusters = 1
    
    if n_clusters <= 1:
        return np.zeros(points.shape[0])
    
    kmeans = KMeans(n_clusters=n_clusters, n_init=10, random_state=42)
    return kmeans.fit_predict(points_scaled)

def plot_contour(points, c='k', bw=.5, ax=None, levels=None, plot_points=True, clusters=None, exp_data=None):
    """
    Plot probability contours for invariant points.
    Supports clustering and experimental data overlay.
    """
    import matplotlib.patches as mpatches
    
    if ax is None:
        fig = Figure()
        ax = fig.subplots()
    else:
        fig = ax.figure
    
    if clusters is None:
        clusters = np.zeros(points.shape[0])
    
    unique_clusters = np.unique(clusters)
    n_clusters = len(unique_clusters)
    
    # Use different color palettes for different clusters if more than one
    if n_clusters > 1:
        cluster_palettes = sns.color_palette("husl", n_clusters)
    else:
        cluster_palettes = [c] if isinstance(c, str) else [c[0] if len(c) > 0 else 'blue']

    handles = []
    
    # Plot experimental data if provided
    if exp_data:
        # Group by label to avoid legend clutter
        grouped_exp = {}
        for item in exp_data:
            label = item.get('label', 'Experimental')
            if label not in grouped_exp:
                grouped_exp[label] = {'x': [], 'T': []}
            grouped_exp[label]['x'].append(item.get('x'))
            grouped_exp[label]['T'].append(item.get('T'))
            
        for label, data in grouped_exp.items():
            exp_line, = ax.plot(data['x'], data['T'], 'r*', markersize=8, label=label, zorder=10)
            handles.append(exp_line)

    # Plot raw points
    if plot_points:
        for i, cid in enumerate(unique_clusters):
            cluster_points = points[clusters == cid]
            label = f"Samples (C{int(cid)})" if n_clusters > 1 else "Invariant Samples"
            color = cluster_palettes[i] if n_clusters > 1 else 'black'
            line, = ax.plot(cluster_points[:, 0], cluster_points[:, 1], '.', color=color, markersize=8, alpha=0.4, label=label, zorder=1)
            if n_clusters > 1:
                handles.append(line)
            elif i == 0:
                handles.append(line)

    if points.shape[0] < 2:
        ax.legend(handles=handles)
        return fig

    # Default levels if not provided
    if levels is None:
        levels = [0.6, 0.8, 0.9]
    
    # Plot KDE contours for each cluster
    for i, cid in enumerate(unique_clusters):
        cluster_points = points[clusters == cid]
        if cluster_points.shape[0] < 3:
            continue
            
        # Determine colors for this cluster's levels
        if n_clusters > 1:
            # Generate a gradient based on the cluster's base color
            base_color = cluster_palettes[i]
            level_colors = sns.light_palette(base_color, n_colors=len(levels)+1)[1:]
        else:
            # Use the provided colors if available
            level_colors = c if not isinstance(c, str) else sns.light_palette(c, n_colors=len(levels)+1)[1:]

        try:
            # Use seaborn's kdeplot for more stable contours
            sns.kdeplot(
                x=cluster_points[:, 0], y=cluster_points[:, 1],
                levels=levels,
                colors=level_colors,
                bw_method=bw,
                ax=ax,
                alpha=0.8,
                linewidths=2,
                zorder=2
            )
            
            # Add legend entries for levels
            for lvl, color in zip(levels, level_colors):
                patch = Patch(color=color, label=f"{int(lvl*100)}% Conf. (C{int(cid)})" if n_clusters > 1 else f"{int(lvl*100)}% Confidence")
                handles.append(patch)
                
        except Exception as e:
            logging.warning(f"KDE plotting failed for cluster {cid}: {e}")

    ax.legend(handles=handles, loc='best', fontsize='small')
    return fig

def plot_phasefracline(eq, coordD, xlabel=None, ylabel=None, xlim=None, yscale=None, phase_label_dict=None, cdict=None, figsize=None, ax=None):
    phaseL = list(np.unique(eq.get('Phase').values))
    if '' in phaseL: phaseL.remove('')
    nph = len(phaseL)
    if coordD:
        coordD = {str(k): v for k, v in coordD.items()}
    eq = eq.sel(coordD)
    rmlist = ['N', 'internal_dof', 'sample', 'vertex']
    max_sz = 0
    dim_max = None
    for dim in list(eq.dims):
        if dim not in rmlist:
            dim_sz = eq.sizes[dim]
            if dim_sz > max_sz:
                max_sz = dim_sz
                dim_max = dim
    if dim_max is None: return
    xvec = eq.get(dim_max).values
    CI = 95
    colorL = sns.color_palette("cubehelix", nph)
    if ax is None:
        fig = Figure(figsize=figsize)
        ax = fig.subplots()
    else:
        fig = ax.figure
    for ii in range(nph):
        phase = phaseL[ii]
        val = eq.NP.where(eq.Phase == phase)
        val = val.sum(dim='vertex').values.squeeze()
        
        # Ensure val shape is (samples, steps)
        if val.ndim == 2:
            if val.shape[0] == len(xvec) and val.shape[1] == eq.sizes.get('sample', 0):
                val = val.T
        
        if yscale is not None:
            val = val * yscale
                
        low, mid, high = np.nanpercentile(val, [0.5*(100-CI), 50, 100-0.5*(100-CI)], axis=0)
        label = phase_label_dict.get(phase, phase) if phase_label_dict else phase
        color = cdict.get(phaseL[ii], colorL[ii]) if cdict else colorL[ii]
        ax.plot(xvec, mid, linestyle='-', color=color, label=label)
        ax.fill_between(np.atleast_1d(xvec), low, high, alpha=0.3, facecolor=color)
    
    if xlim: ax.set_xlim(xlim)
    else: ax.set_xlim([xvec.min(), xvec.max()])
    
    if yscale is None:
        ax.set_ylim([-0.01, 1.01])
        
    if xlabel: ax.set_xlabel(xlabel, fontsize='large')
    if ylabel: ax.set_ylabel(ylabel, fontsize='large')
    else: ax.set_ylabel('phase fraction', fontsize='large')
    
    ax.legend()
    fig.tight_layout()
    return fig

def plot_phasecompline(eq, coordD, comp, xlabel=None, ylabel=None, xlim=None, yscale=None, phase_label_dict=None, cdict=None, figsize=None, ax=None):
    phaseL = list(np.unique(eq.get('Phase').values))
    if '' in phaseL: phaseL.remove('')
    nph = len(phaseL)
    if coordD:
        coordD = {str(k): v for k, v in coordD.items()}
    eq = eq.sel(coordD)
    rmlist = ['N', 'internal_dof', 'sample', 'vertex']
    max_sz = 0
    dim_max = None
    for dim in list(eq.dims):
        if dim not in rmlist:
            dim_sz = eq.sizes[dim]
            if dim_sz > max_sz:
                max_sz = dim_sz
                dim_max = dim
    if dim_max is None: return
    xvec = eq.get(dim_max).values
    CI = 95
    colorL = sns.color_palette("cubehelix", nph)
    if ax is None:
        fig = Figure(figsize=figsize)
        ax = fig.subplots()
    else:
        fig = ax.figure
    for ii in range(nph):
        phase = phaseL[ii]
        val = eq.X.where(eq.Phase == phase).sel(component=comp)
        val = val.sum(dim='vertex').values.squeeze()
        
        # Mask out values where phase fraction is essentially zero
        np_val = eq.NP.where(eq.Phase == phase).sum(dim='vertex').values.squeeze()
        
        # Ensure shapes are (samples, steps)
        if val.ndim == 2:
            if val.shape[0] == len(xvec) and val.shape[1] == eq.sizes.get('sample', 0):
                val = val.T
        if np_val.ndim == 2:
            if np_val.shape[0] == len(xvec) and np_val.shape[1] == eq.sizes.get('sample', 0):
                np_val = np_val.T
                
        val[np_val < 1e-6] = np.nan
        
        # If all nan, skip
        if np.all(np.isnan(val)):
            continue
            
        if yscale is not None:
            val = val * yscale

        low, mid, high = np.nanpercentile(val, [0.5*(100-CI), 50, 100-0.5*(100-CI)], axis=0)
        label = phase_label_dict.get(phase, phase) if phase_label_dict else phase
        color = cdict.get(phaseL[ii], colorL[ii]) if cdict else colorL[ii]
        ax.plot(xvec, mid, linestyle='-', color=color, label=label)
        ax.fill_between(np.atleast_1d(xvec), low, high, alpha=0.3, facecolor=color)
    
    if xlim: ax.set_xlim(xlim)
    else: ax.set_xlim([xvec.min(), xvec.max()])
    
    if yscale is None:
        ax.set_ylim([-0.01, 1.01])
        
    if xlabel: ax.set_xlabel(xlabel, fontsize='large')
    if ylabel: ax.set_ylabel(ylabel, fontsize='large')
    else: ax.set_ylabel(f'{comp} composition', fontsize='large')
    
    ax.legend()
    fig.tight_layout()
    return fig

def plot_superimposed(eq, comp, nsp=None, alpha=None, phase_label_dict=None, xlims=None, cdict=None, figsize=None, markersize=1, ax=None):
    phaseL = list(np.unique(eq.get('Phase').values))
    if '' in phaseL: phaseL.remove('')
    nph = len(phaseL)
    if nsp is None: nsp = len(eq.sample)
    if ax is None:
        fig = Figure(figsize=figsize)
        ax = fig.subplots()
    else:
        fig = ax.figure
    for ii in range(nsp):
        plot_binary(eq.sel(sample=ii), comp=comp, alpha=alpha, cdict=cdict, markersize=markersize, ax=ax)
    colorL = sns.color_palette("cubehelix", nph)
    Tvec = eq.get('T').values
    for ii in range(nph):
        phase = phaseL[ii]
        color = cdict.get(phaseL[ii], colorL[ii]) if cdict else colorL[ii]
        label = phase_label_dict.get(phase, phase) if phase_label_dict else phase
        ax.plot(1.5, Tvec[0], color=color, linestyle='', marker='.', label=label)
    if xlims is None:
        Xvec = eq.get('X_' + comp).values
        Xrng = Xvec.max() - Xvec.min()
        xlims = [Xvec.min() - 0.005*Xrng, Xvec.max() + 0.005*Xrng]
    ax.set_xlim(xlims)
    ax.set_ylim([Tvec.min(), Tvec.max()])
    ax.set_xlabel(r'$\mathrm{x_{%s}}$' % comp, fontsize='large')
    ax.set_ylabel('T (K)', fontsize='large')
    ax.legend()
    fig.tight_layout()
    return fig

def plot_trace(trace, plabelL=None, figsize=None, savefig=False):
    nwalkers, nlinksT, npar = trace.shape
    fig = Figure(figsize=(figsize[0] if figsize else 8, 3*npar))
    axes = fig.subplots(npar, 1)
    if npar == 1: axes = [axes]
    for ii in range(npar):
        ax = axes[ii]
        if nwalkers > 10:
            for jj in range(nwalkers-2):
                ax.plot(range(nlinksT), trace[jj, :, ii], linestyle='-', marker='', color=[0.3, 0.3, 0.5], lw=.75, alpha=.15)
            for jj in range(nwalkers-2, nwalkers):
                ax.plot(range(nlinksT), trace[jj, :, ii], linestyle='-', marker='', color='k', lw=.75, alpha=.8)
        else:
            for jj in range(nwalkers):
                ax.plot(range(nlinksT), trace[jj, :, ii], linestyle='-', marker='', color=[0.3, 0.3, 0.5], lw=.75, alpha=.6)
        ax.set_xlabel('iteration number')
        if plabelL is not None: ax.set_ylabel(plabelL[ii], fontsize=15)
        else: ax.set_ylabel('param %s' % ii, fontsize=15)
        ax.set_xlim([0, nlinksT])
    fig.tight_layout()
    return fig
