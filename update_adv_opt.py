import re

with open('components/AdvancedOptimization.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add axisComp state
content = re.sub(
    r"const \[outTdbName, setOutTdbName\].*?;",
    r"const [outTdbName, setOutTdbName] = useState<string>('A25-CU-MG_Best_Final.tdb');\n  const [axisComp, setAxisComp] = useState<string>('MG');",
    content
)

# 2. Add LSE weights and tau
content = re.sub(
    r"const \[weights, setWeights\].*?;",
    r"const [weights, setWeights] = useState({ HM: 5.0, ACR: 15.0, SM: 0.02, ZPF: 100.0, EXP: 100.0, DFT: 80.0, EST: 20.0, weightLSE: 10.0, weightSum: 0.05, tau: 1000.0 });",
    content
)

# 3. Add maxAllowedDevInitial
content = re.sub(
    r"const \[thresholds, setThresholds\].*?;",
    r"const [thresholds, setThresholds] = useState({ hmSigma: 0.2, smSigma: 0.1, allowedDev: 0.05, maxAllowedDevInitial: 1.0 });",
    content
)

# 4. Add UI for axisComp
axis_ui = """              <div className="space-y-1">
                <label className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Axis Component</label>
                <div className="flex border border-[var(--industrial-border)] bg-black">
                  <div className="bg-[var(--industrial-border)] px-3 flex items-center justify-center"><Hash size={14} className="text-slate-400" /></div>
                  <input type="text" value={axisComp} onChange={e => setAxisComp(e.target.value)} className="w-full bg-transparent px-3 py-2 text-[11px] text-emerald-300 font-mono outline-none" placeholder="e.g. MG" />
                </div>
              </div>"""

content = re.sub(
    r"\{/\* Dataset Selection \*/\}",
    axis_ui + "\n\n              {/* Dataset Selection */}",
    content
)

# 5. Add UI for LSE weights, tau, hmSigma, smSigma, maxAllowedDevInitial
# We'll just replace the entire Weights section to include the new fields.
weights_ui_pattern = r"\{/\* Weights \*/\}.*?\{/\* Action Buttons \*/\}"
new_weights_ui = """{/* Settings & Thresholds */}
              <div className="space-y-3">
                <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest">
                  <Sliders size={12} className="text-emerald-500" /><span>Settings & Thresholds</span>
                </div>
                <div className="grid grid-cols-2 gap-3 bg-black border border-[var(--industrial-border)] rounded-none p-4">
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">Max Allowed Dev Init (%)</label><input type="number" step="0.1" value={thresholds.maxAllowedDevInitial} onChange={e => handleThresholdChange('maxAllowedDevInitial', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-purple-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">Min Allowed Dev End (%)</label><input type="number" step="0.01" value={thresholds.allowedDev} onChange={e => handleThresholdChange('allowedDev', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-purple-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">HM Sigma Factor</label><input type="number" step="0.01" value={thresholds.hmSigma} onChange={e => handleThresholdChange('hmSigma', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-purple-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">SM Sigma Factor</label><input type="number" step="0.01" value={thresholds.smSigma} onChange={e => handleThresholdChange('smSigma', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-purple-300 font-mono" /></div>
                </div>
              </div>

              {/* Weights */}
              <div className="space-y-3">
                <div className="flex items-center space-x-2 text-[9px] font-black text-slate-500 uppercase tracking-widest">
                  <Sliders size={12} className="text-emerald-500" /><span>Weights (W_PROP, W_SRC & ZPF penalties)</span>
                </div>
                <div className="grid grid-cols-2 gap-3 bg-black border border-[var(--industrial-border)] rounded-none p-4">
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">HM</label><input type="number" value={weights.HM} onChange={e => handleWeightChange('HM', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-emerald-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">ACR</label><input type="number" value={weights.ACR} onChange={e => handleWeightChange('ACR', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-emerald-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">SM</label><input type="number" step="0.01" value={weights.SM} onChange={e => handleWeightChange('SM', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-emerald-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">ZPF</label><input type="number" value={weights.ZPF} onChange={e => handleWeightChange('ZPF', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-emerald-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">EXP</label><input type="number" value={weights.EXP} onChange={e => handleWeightChange('EXP', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-amber-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">DFT</label><input type="number" value={weights.DFT} onChange={e => handleWeightChange('DFT', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-amber-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">EST</label><input type="number" value={weights.EST} onChange={e => handleWeightChange('EST', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-amber-300 font-mono" /></div>
                  
                  <div className="col-span-2 pt-2 border-t border-[var(--industrial-border)] mt-2"></div>
                  
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">ZPF LSE Weight</label><input type="number" step="1" value={weights.weightLSE} onChange={e => handleWeightChange('weightLSE', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-rose-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">ZPF SUM Weight</label><input type="number" step="0.01" value={weights.weightSum} onChange={e => handleWeightChange('weightSum', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-rose-300 font-mono" /></div>
                  <div className="space-y-1"><label className="text-[8px] text-slate-600 font-bold uppercase">ZPF LSE TAU</label><input type="number" step="100" value={weights.tau} onChange={e => handleWeightChange('tau', e.target.value)} className="w-full bg-black border border-[var(--industrial-border)] px-3 py-1.5 text-[10px] text-rose-300 font-mono" /></div>
                </div>
              </div>

              {/* Action Buttons */}\n"""

content = re.sub(weights_ui_pattern, new_weights_ui, content, flags=re.DOTALL)

# 6. Include axisComp in body of /run-adv-opt
run_adv_req = r"body: JSON.stringify\({\n\s*initial_tdb: initialTdb,\n\s*dataset_folder: datasetFolder,\n\s*out_db_name: outDbName,\n\s*out_tdb_name: outTdbName,\n\s*weights,\n\s*thresholds,\n\s*iters\n\s*}\)"
new_run_adv_req = """body: JSON.stringify({
          initial_tdb: initialTdb,
          dataset_folder: datasetFolder,
          out_db_name: outDbName,
          out_tdb_name: outTdbName,
          axis_comp: axisComp,
          weights,
          thresholds,
          iters
        })"""

content = re.sub(run_adv_req, new_run_adv_req, content)

with open('components/AdvancedOptimization.tsx', 'w', encoding='utf-8') as f:
    f.write(content)

