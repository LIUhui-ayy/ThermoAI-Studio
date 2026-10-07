import re

with open('components/AdvancedOptimization.tsx', 'r') as f:
    content = f.read()

target = """                   {/* Row 2: Parameters Trajectory */}
                   <div className="border border-[var(--industrial-border)] bg-black p-2 flex flex-col relative h-full">
                      <span className="absolute top-2 left-2 text-[8px] font-black text-slate-500 uppercase z-10">Parameter Trajectories</span>
                      <div className="flex-1 w-full h-full min-h-0 pt-6">
                        {scatterData.length === 0 ? (
                           <div className="w-full h-full flex items-center justify-center text-[10px] font-mono text-slate-600">Waiting for tracing data...</div>
                        ) : (
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={scatterData} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                            <XAxis type="number" dataKey="trial" stroke="#64748b" tick={{ fill: '#64748b', fontSize: 9, fontFamily: 'JetBrains Mono' }} domain={['dataMin', 'dataMax']} />
                            <YAxis stroke="#64748b" tick={{ fill: '#64748b', fontSize: 9, fontFamily: 'JetBrains Mono' }} domain={['auto', 'auto']} />
                            <Tooltip contentStyle={{ backgroundColor: '#020617', borderColor: '#334155', borderRadius: '0px', fontFamily: 'JetBrains Mono', fontSize: '10px' }} />
                            {scatterData.length > 0 && Object.keys(scatterData[0]).filter(k => k !== 'trial' && k !== 'score').map((key, i) => (
                              <Line key={key} type="monotone" dataKey={key} stroke={`hsl(${(i * 137.508) % 360}, 70%, 50%)`} dot={false} strokeWidth={2} name={key} isAnimationActive={false} />
                            ))}
                          </LineChart>
                        </ResponsiveContainer>
                        )}
                      </div>
                   </div>"""

replacement = """                   {/* Row 2: Parameters Trajectory */}
                   <div className="border border-[var(--industrial-border)] bg-black p-2 flex flex-col relative h-full">
                      <span className="absolute top-2 left-2 text-[8px] font-black text-slate-500 uppercase z-10">Parameter Trajectories</span>
                      <div className="flex-1 w-full h-full min-h-0 pt-6 overflow-y-auto custom-scrollbar">
                        {scatterData.length === 0 ? (
                           <div className="w-full h-full flex items-center justify-center text-[10px] font-mono text-slate-600">Waiting for tracing data...</div>
                        ) : (
                           <div className="grid grid-cols-2 gap-4">
                             {Object.keys(scatterData[0]).filter(k => k !== 'trial' && k !== 'score').map((key, i) => (
                               <div key={key} className="h-40 border border-[#334155] p-1 relative">
                                 <span className="absolute top-1 right-2 text-[8px] font-mono text-slate-400 z-10">{key}</span>
                                 <ResponsiveContainer width="100%" height="100%">
                                   <LineChart data={scatterData} margin={{ top: 15, right: 5, left: 0, bottom: 0 }}>
                                     <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                                     <XAxis type="number" dataKey="trial" stroke="#475569" tick={{ fill: '#475569', fontSize: 8, fontFamily: 'JetBrains Mono' }} domain={['dataMin', 'dataMax']} />
                                     <YAxis stroke="#475569" tick={{ fill: '#475569', fontSize: 8, fontFamily: 'JetBrains Mono' }} domain={['auto', 'auto']} width={35} />
                                     <Tooltip contentStyle={{ backgroundColor: '#020617', borderColor: '#334155', borderRadius: '0px', fontFamily: 'JetBrains Mono', fontSize: '9px' }} />
                                     <Line type="monotone" dataKey={key} stroke={`hsl(${(i * 137.508) % 360}, 70%, 50%)`} dot={false} strokeWidth={1.5} name={key} isAnimationActive={false} />
                                   </LineChart>
                                 </ResponsiveContainer>
                               </div>
                             ))}
                           </div>
                        )}
                      </div>
                   </div>"""

content = content.replace(target, replacement)

with open('components/AdvancedOptimization.tsx', 'w') as f:
    f.write(content)
