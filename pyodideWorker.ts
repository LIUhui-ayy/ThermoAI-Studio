
// @ts-ignore
importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.1/full/pyodide.js");

let pyodide: any;

/**
 * 6-Step Engine Initialization Sequence
 */
async function getEngine() {
  if (pyodide) return pyodide;

  try {
    // Step 1: Core Runtime
    self.postMessage({ type: 'status', message: '[1/6] Loading Pyodide Runtime (v0.25+)...' });
    // @ts-ignore
    pyodide = await loadPyodide();

    // Step 2: Core Packages
    self.postMessage({ type: 'status', message: '[2/6] Loading Core Packages (numpy, scipy, pandas, scikit-learn)...' });
    await pyodide.loadPackage(["micropip", "numpy", "scipy", "pandas", "scikit-learn"]);

    // Step 3: Scientific Stack (ESPEI/PyCalphad)
    self.postMessage({ type: 'status', message: '[3/6] Installing ESPEI & PyCalphad via Micropip... (This process takes 1-2 mins)' });
    const micropip = pyodide.pyimport("micropip");
    await micropip.install(['pyyaml', 'tinydb', 'symengine', 'pycalphad', 'espei']);

    // Inject Native Brain
    await pyodide.runPythonAsync(pythonEngineScript);
    
    return pyodide;
  } catch (err) {
    self.postMessage({ type: 'ERROR', error: `Engine Bootstrap Failed: ${err.message}` });
    throw err;
  }
}

const pythonEngineScript = `
import sys, io, json
import numpy as np
from js import self as js_self

# Capture stdout/stderr for logging
class ProgressLogger(io.StringIO):
    def write(self, s):
        if s.strip():
            js_self.postMessage(json.dumps({"type": "log", "message": s.strip()}))
        return super().write(s)

sys.stdout = ProgressLogger()
sys.stderr = sys.stdout

def run_task(pm_content, ds_contents_list, config_json):
    print("[4/6] Mapping files from Resource Hub to Virtual Filesystem...")
    
    try:
        from espei import generate_parameters
        from pycalphad import Database
        import espei
        
        # 1. Parse Inputs
        pm = json.loads(pm_content)
        datasets = [json.loads(d) for d in ds_contents_list]
        conf = json.loads(config_json)
        
        # Build penalty dict
        penalties = conf.get('aicc_penalty', [])
        penalty_dict = {p['phase']: {'HM': p['hm'], 'SM': p['sm']} for p in penalties}
        
        print(f"[5/6] Executing Native ESPEI generate_parameters for {len(datasets)} datasets...")
        
        # 2. Native ESPEI Invocation
        dbf = generate_parameters(
            pm, 
            datasets, 
            ref_state=conf.get('ref_state', 'SGTE91'), 
            excess_model='linear', 
            aicc_penalty_factor=penalty_dict
        )
        
        print("[6/6] Finalizing TDB and Log output...")
        
        # 3. Native PyCalphad Export
        tdb_str = dbf.to_string(format='tdb')
        
        return json.dumps({
            "success": True,
            "tdb": tdb_str,
            "components": list(dbf.elements),
            "log": sys.stdout.getvalue()
        })
    except Exception as e:
        import traceback
        err_msg = str(e)
        trace = traceback.format_exc()
        print(f"[CRITICAL] {err_msg}")
        return json.dumps({
            "success": False, 
            "error": err_msg, 
            "traceback": trace,
            "log": sys.stdout.getvalue()
        })

def calculate_equilibrium(tdb_string, components):
    try:
        from pycalphad import Database, equilibrium, variables as v
        tdb_string = tdb_string.replace('\r\n', '\n').replace('\r', '\n').replace('\xa0', ' ')
        dbf = Database(tdb_string)
        comps = [c.upper() for c in components if c.upper() != 'VA'] + ['VA']
        phases = list(dbf.phases.keys())
        
        conds = {v.P: 101325, v.T: (300, 2000, 50), v.X(comps[0]): (0, 1, 0.1)}
        eq = equilibrium(dbf, comps, phases, conds)
        
        return json.dumps({
            "success": True,
            "data": eq.to_dict()
        }, default=lambda x: x.tolist() if isinstance(x, np.ndarray) else str(x))
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})
`;

self.onmessage = async (e) => {
  const { type, payload } = e.data;
  
  try {
    const py = await getEngine();
    
    if (type === 'RUN_FITTING') {
      const runTask = py.globals.get('run_task');
      const resultJson = runTask(
        payload.phaseModel, 
        payload.datasets, 
        JSON.stringify(payload.config)
      );
      
      const parsed = JSON.parse(resultJson);
      self.postMessage({ type: 'FITTING_RESULT', result: parsed });
    }
    
    if (type === 'CALC_EQUILIBRIUM') {
      const calcEq = py.globals.get('calculate_equilibrium');
      const resultJson = calcEq(payload.tdb, payload.components);
      self.postMessage({ type: 'EQUILIBRIUM_RESULT', result: JSON.parse(resultJson) });
    }
  } catch (err) {
    self.postMessage({ type: 'ERROR', error: (err as Error).message });
  }
};
