
import React, { useState, useRef, useEffect } from 'react';
import { 
  Upload, 
  FileText, 
  Wand2, 
  Save, 
  FileJson, 
  Database,
  AlertCircle, 
  Sparkles, 
  Loader2, 
  Copy, 
  ChevronRight, 
  FileUp, 
  X, 
  ExternalLink,
  BookOpen,
  Table as TableIcon,
  ChevronLeft,
  Trash2,
  FolderOpen,
  CheckCircle
} from 'lucide-react';
import { GoogleGenAI } from "@google/genai";
import { FileNode, LiteratureState } from '../types';
import { Document, Page, pdfjs } from 'react-pdf';
import { TDB_EXTRACTION_PROMPT } from '../tdb_prompt';

// Initialize PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface LiteratureAgentProps {
  setFiles: React.Dispatch<React.SetStateAction<FileNode[]>>;
  state: LiteratureState;
  setState: React.Dispatch<React.SetStateAction<LiteratureState>>;
}

const LITERATURE_SYSTEM_INSTRUCTION = `# System Prompt: Independent Literature Agent (Final Version)

**Role**
You are a **Senior CALPHAD Thermodynamics Expert & Literature Intelligence Analyst**.
Your core task is to deeply read the user-uploaded PDF literature (especially those related to thermodynamics, phase diagrams, and phase equilibria). You must not only extract models and conclusions but also keenly capture specific experimental data scattered in the text, organize the author's assessment of previous work, and ultimately output structured data conforming to the ESPEI standard.

**Output Style Guidelines**
1. **Typography Hierarchy**: Strictly use H2 (##) > H3 (###) > H4 (####) and lower levels.
2. **Visual Guidance**: Use Emoji icons (e.g. 📘, ⚖️, 💎, 🧬, ✅, ❌) to distinguish sections.
3. **Citation Emphasis**: Use \`> blockquotes\` to show the author's core views or original evaluations.
4. **Data Tabulation**: Anything involving data listing or chart indexing **MUST** be displayed using Markdown tables.
5. **JSON Purity**: Phase model JSON must be independent, un-commented code blocks.

---

**Task Workflow & Output Structure**

Please output the content strictly in the order and requirements of the following **four core sections**:

#### 📘 Section 1: Literature Summary
Please summarize concisely in professional English:
* **🎯 Main Objective**: Summarize in one sentence what pain point this paper solved? Which system was studied?
* **🛠️ Methodology**: Includes experimental and computational methods.
* **🏆 Key Achievements**: List the 3 most important contributions as bullet points.

#### ⚖️ Section 2: Previous Work Assessment
Organize the author's evaluation of the quality of previous data:
* **✅ Reliable Data**: Whose data did the author adopt? Why?
* **❌ Discarded Data**: Whose data did the author exclude? What is the reason?
* **⚠️ Controversies**: What were the main historical disagreements?

#### 💎 Section 3: Deep Data Mining
**3.1 📝 Textual Data Extraction**
Scan paragraphs and extract specific values that are **not listed in tables but directly mentioned in the text**. Format as a table:
| Data Type | Value & Unit | Conditions (T, P, Comp) | Original Context/Notes |
| :--- | :--- | :--- | :--- |

**3.2 📊 Tables & Figures Index**
List key table/figure numbers and the data types they contain.

#### 🧬 Section 4: Phase Model Extraction
**4.1 Modeling Strategy Analysis**
Briefly describe the reasons for phase model selection.
**4.2 ESPEI Standard JSON (Core Output)**
Only output JSON code blocks conforming to ESPEI/PyCalphad standards. All component names must be capitalized.

---
**Constraints**
* Ensure all component names are uppercase.
* JSON must be valid, without comments.
* Strictly forbidden to mix Markdown text inside JSON.`;

const LiteratureAgent: React.FC<LiteratureAgentProps> = ({ setFiles, state, setState }) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const showToast = (msg: string) => setToast(msg);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile && selectedFile.type === 'application/pdf') {
      processFile(selectedFile);
    } else if (selectedFile) {
      setError("Only PDF files are supported for scientific literature analysis.");
    }
  };

  const processFile = (selectedFile: File) => {
    if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
    const url = URL.createObjectURL(selectedFile);
    
    setState({
      ...state,
      file: selectedFile,
      fileUrl: url,
      markdownReport: null,
      jsonData: null,
      tdbData: null,
      pageNumber: 1,
      numPages: 0
    });

    setError(null);
    setUploadProgress(0);
    const interval = setInterval(() => {
      setUploadProgress(prev => {
        if (prev >= 100) {
          clearInterval(interval);
          saveToUploads(selectedFile);
          return 100;
        }
        return prev + 25;
      });
    }, 80);
  };

  const saveToUploads = (uploadedFile: File) => {
    const newFile: FileNode = {
      id: Math.random().toString(36).substr(2, 9),
      name: uploadedFile.name,
      type: 'file',
      path: `/uploads/${uploadedFile.name}`,
      content: "[PDF Meta Data Indexed]"
    };

    setFiles(prev => {
      const root = { ...prev[0] };
      let folder = root.children?.find(c => c.name === 'uploads');
      if (!folder) {
        folder = { id: 'uploads-dir', name: 'uploads', type: 'folder', path: '/uploads', children: [] };
        root.children = [folder, ...(root.children || [])];
      }
      if (!folder.children?.find(c => c.name === newFile.name)) {
        folder.children = [...(folder.children || []), newFile];
      }
      return [root];
    });
  };

  const resetSession = () => {
    if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
    setState({
      file: null,
      fileUrl: null,
      markdownReport: null,
      jsonData: null,
      tdbData: null,
      numPages: 0,
      pageNumber: 1,
      pdfScale: 1.1
    });
    setError(null);
    setUploadProgress(0);
    showToast("Session reset successful.");
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve((reader.result as string).split(',')[1]);
      reader.onerror = error => reject(error);
    });
  };

  const startExtraction = async (mode: 'deep' | 'tdb' = 'deep') => {
    if (!state.file) return;
    setIsProcessing(true);
    setError(null);

    try {
      const base64Data = await fileToBase64(state.file);
      // Create new instance of GoogleGenAI using the correct named parameter.
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      
      let systemInstruction = LITERATURE_SYSTEM_INSTRUCTION;
      let promptText = "Analyze this paper deeply. Extract textual thermodynamic values and assess literature reviews. Provide standard ESPEI JSON.";
      
      if (mode === 'tdb') {
        try {
          const tdbPromptFile = await fetch('/sgte.tdb');
          if (!tdbPromptFile.ok) {
            throw new Error(`Failed to load SGTE database: ${tdbPromptFile.statusText} (${tdbPromptFile.status})`);
          }
          const sgteText = await tdbPromptFile.text();
          systemInstruction = TDB_EXTRACTION_PROMPT;
          promptText = "The following is the SGTE Unary Database v5.0 Unarities:\n" + sgteText + "\n\nBased on the uploaded document and the provided rules, extract the TDB data according to the system instructions. Ensure all pure element functions are copied exactly from the provided SGTE text.";
        } catch (fetchErr: any) {
          throw new Error(`Error loading TDB resources: ${fetchErr.message}`);
        }
      }
      
      // Update contents to use { parts: [...] } structure for consistency with guidelines.
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: [
          { inlineData: { data: base64Data, mimeType: 'application/pdf' } },
          { text: promptText }
        ],
        config: { systemInstruction, temperature: 0.1 },
      });

      // Extract generated text directly from the response object's property.
      const text = response.text || "";
      if (mode === 'tdb') {
        const tdbMatch = text.match(/```tdb\s*([\s\S]*?)\s*```/i);
        if (tdbMatch) {
          setState(prev => ({
            ...prev,
            tdbData: tdbMatch[1],
            markdownReport: text.replace(tdbMatch[0], '').trim()
          }));
        } else {
          setState(prev => ({ ...prev, markdownReport: text }));
        }
      } else {
        const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
        
        if (jsonMatch) {
          setState(prev => ({
            ...prev,
            jsonData: jsonMatch[1],
            markdownReport: text.replace(jsonMatch[0], '').trim()
          }));
        } else {
          setState(prev => ({ ...prev, markdownReport: text }));
        }
      }
    } catch (err: any) {
      console.error("Gemini API Error Detail:", err);
      let errorMsg = "Gemini API failure.";
      if (err.message) {
        errorMsg = err.message;
        if (err.message.includes("429") || err.message.toLowerCase().includes("quota")) {
          errorMsg = "API Quota exceeded. Please try again later or check your API key tier.";
        }
      }
      setError(errorMsg);
    } finally {
      setIsProcessing(false);
    }
  };

  const saveReportToWorkspace = () => {
    if (!state.markdownReport) return;
    const fileName = `report_${Date.now()}.md`;
    
    const newFile: FileNode = {
      id: Math.random().toString(36).substr(2, 9),
      name: fileName,
      type: 'file',
      path: `/extracted_data/${fileName}`,
      content: state.markdownReport
    };

    setFiles(prev => {
      const root = { ...prev[0] };
      let folder = root.children?.find(c => c.name === 'extracted_data');
      if (!folder) {
        folder = { id: 'ext-data-dir', name: 'extracted_data', type: 'folder', path: '/extracted_data', children: [] };
        root.children?.push(folder);
      }
      folder.children = [...(folder.children || []), newFile];
      return [root];
    });
    showToast(`Report saved: ${fileName}`);
  };

  const saveModelToWorkspace = () => {
    if (!state.jsonData) return;
    try {
      const parsed = JSON.parse(state.jsonData);
      const systemName = parsed.components?.filter((c: string) => c !== 'VA').join('-') || 'unknown';
      const fileName = `${systemName}_model_${Date.now()}.json`;

      const newFile: FileNode = {
        id: Math.random().toString(36).substr(2, 9),
        name: fileName,
        type: 'file',
        path: `/models/${fileName}`,
        content: state.jsonData
      };

      setFiles(prev => {
        const root = { ...prev[0] };
        let folder = root.children?.find(c => c.name === 'models');
        if (!folder) {
          folder = { id: 'models-dir', name: 'models', type: 'folder', path: '/models', children: [] };
          root.children?.push(folder);
        }
        folder.children = [...(folder.children || []), newFile];
        return [root];
      });
      showToast(`Model exported: ${fileName}`);
    } catch (e) {
      alert("JSON validation error.");
    }
  };

  const saveTDBToWorkspace = () => {
    if (!state.tdbData) return;
    try {
      const fileName = `thermo_model_${Date.now()}.tdb`;
      
      // Save to virtual file system
      const newFile: FileNode = {
        id: Math.random().toString(36).substr(2, 9),
        name: fileName,
        type: 'file',
        path: `/databases/${fileName}`,
        content: state.tdbData
      };

      setFiles(prev => {
        const root = { ...prev[0] };
        let folder = root.children?.find(c => c.name === 'databases');
        if (!folder) {
          folder = { id: 'databases-dir', name: 'databases', type: 'folder', path: '/databases', children: [] };
          root.children?.push(folder);
        }
        folder.children = [...(folder.children || []), newFile];
        return [root];
      });

      // Also trigger a local download
      const blob = new Blob([state.tdbData], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      showToast(`TDB saved to workspace and downloaded: ${fileName}`);
    } catch (e) {
      alert("TDB save error.");
    }
  };

  // Fixed the missing onDocumentLoadSuccess handler
  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setState(prev => ({ ...prev, numPages }));
  };

  return (
    <div className="h-full flex flex-col bg-black overflow-hidden relative">
      {/* Toast Notification */}
      {toast && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-top-4 fade-in duration-300">
          <div className="bg-emerald-600 text-white px-6 py-2.5 rounded-none shadow-2xl flex items-center space-x-3 border border-emerald-500/50">
            <CheckCircle size={18} />
            <span className="text-sm font-bold tracking-tight uppercase">{toast}</span>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="h-16 bg-black border-b border-[var(--industrial-border)] px-6 flex items-center justify-between shrink-0 z-20">
        <div className="flex items-center space-x-4">
          <div className="p-2.5 bg-[var(--industrial-accent)] rounded-none">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div className="hidden sm:block">
            <h1 className="text-sm font-bold text-white tracking-tight leading-none mb-1 uppercase">Literature Agent</h1>
            <p className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Scientific Insights Hub v4.1</p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          {state.file && (
            <div className="flex items-center space-x-3 bg-black px-4 py-2 rounded-none border border-[var(--industrial-border)]">
              <FileText className="w-4 h-4 text-[var(--industrial-accent)]" />
              <span className="text-xs font-bold text-slate-300 max-w-[140px] truncate font-mono">{state.file.name}</span>
              <button onClick={resetSession} className="hover:text-red-400 text-slate-500 transition-colors" title="Clear/Reset Session">
                <Trash2 size={16} />
              </button>
            </div>
          )}
          
          <button 
            onClick={() => fileInputRef.current?.click()} 
            className="flex items-center space-x-2 bg-black hover:bg-slate-700 text-slate-200 px-4 py-2 rounded-none text-xs font-bold transition-all border border-[var(--industrial-border)] uppercase tracking-widest"
          >
            <FileUp size={16} />
            <span>Open Paper</span>
          </button>
          <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept=".pdf" className="hidden" />
          
          <button 
            onClick={() => startExtraction('deep')}
            disabled={isProcessing || !state.file}
            className="flex items-center space-x-2 bg-[var(--industrial-accent)] hover:bg-[var(--industrial-accent-muted)] disabled:bg-slate-900 disabled:text-slate-500 text-white px-6 py-2 rounded-none text-xs font-bold shadow-lg uppercase tracking-widest"
          >
            {isProcessing ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
            <span>{isProcessing ? 'Analyzing...' : 'Deep Extract'}</span>
          </button>

          <button 
            onClick={() => startExtraction('tdb')}
            disabled={isProcessing || !state.file}
            className="flex items-center space-x-2 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-900 disabled:text-slate-500 text-white px-6 py-2 rounded-none text-xs font-bold shadow-lg uppercase tracking-widest border border-slate-600"
          >
            {isProcessing ? <Loader2 size={16} className="animate-spin" /> : <Database size={16} />}
            <span>{isProcessing ? 'TDB...' : 'Extract TDB'}</span>
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Reader View */}
        <div className="flex-1 border-r border-[var(--industrial-border)] bg-black flex flex-col relative overflow-hidden">
          {!state.file ? (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-center" onClick={() => fileInputRef.current?.click()}>
              <div className="w-24 h-24 rounded-none bg-black border-2 border-dashed border-[var(--industrial-border)] flex items-center justify-center mb-6 cursor-pointer hover:border-[var(--industrial-accent)]/50">
                <Upload className="w-10 h-10 text-slate-700" />
              </div>
              <p className="text-xs text-slate-500 max-w-sm uppercase tracking-tighter">Drop thermodynamic publications here to begin high-fidelity data extraction.</p>
            </div>
          ) : (
            <div className="flex-1 flex flex-col h-full overflow-hidden">
              <div className="h-10 bg-black border-b border-[var(--industrial-border)] flex items-center px-4 justify-between shrink-0">
                <div className="flex items-center space-x-4">
                  <div className="flex items-center space-x-2">
                    <BookOpen className="w-4 h-4 text-[var(--industrial-accent)]" />
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Scientific Reader</span>
                  </div>
                  {state.numPages > 0 && (
                    <div className="flex items-center space-x-2 bg-black px-2 py-0.5 rounded-none border border-[var(--industrial-border)]">
                      <button disabled={state.pageNumber <= 1} onClick={() => setState(p => ({...p, pageNumber: p.pageNumber - 1}))} className="p-1 hover:text-white disabled:opacity-30"><ChevronLeft size={14} /></button>
                      <span className="text-[10px] text-slate-400 font-mono">{state.pageNumber} / {state.numPages}</span>
                      <button disabled={state.pageNumber >= state.numPages} onClick={() => setState(p => ({...p, pageNumber: p.pageNumber + 1}))} className="p-1 hover:text-white disabled:opacity-30"><ChevronRight size={14} /></button>
                    </div>
                  )}
                </div>
                <div className="flex items-center space-x-4">
                  <div className="flex items-center space-x-2 bg-black px-3 py-0.5 rounded-none border border-[var(--industrial-border)]">
                    <button onClick={() => setState(p => ({...p, pdfScale: Math.max(0.5, p.pdfScale - 0.1)}))} className="text-[10px] hover:text-white font-bold">-</button>
                    <span className="text-[9px] text-slate-500 w-10 text-center font-mono">{Math.round(state.pdfScale * 100)}%</span>
                    <button onClick={() => setState(p => ({...p, pdfScale: Math.min(3, p.pdfScale + 0.1)}))} className="text-[10px] hover:text-white font-bold">+</button>
                  </div>
                  {state.fileUrl && <a href={state.fileUrl} target="_blank" className="p-1.5 hover:bg-slate-800 rounded-none text-slate-500 hover:text-white"><ExternalLink size={14} /></a>}
                </div>
              </div>
              <div className="flex-1 w-full bg-black overflow-auto flex flex-col items-center py-6 custom-scrollbar">
                <Document file={state.fileUrl} onLoadSuccess={onDocumentLoadSuccess}>
                  <Page pageNumber={state.pageNumber} scale={state.pdfScale} renderTextLayer={false} renderAnnotationLayer={false} className="shadow-2xl border border-[var(--industrial-border)]" />
                </Document>
              </div>
            </div>
          )}
        </div>

        {/* Extraction Report View */}
        <div className="flex-1 flex flex-col bg-black border-l border-[var(--industrial-border)] overflow-hidden">
          <div className="h-10 bg-black border-b border-[var(--industrial-border)] flex items-center px-4 justify-between shrink-0">
             <div className="flex items-center space-x-2">
                <TableIcon size={14} className="text-[var(--industrial-accent)]" />
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Scientific Insights Report</span>
             </div>
             <div className="flex items-center space-x-2">
               {state.markdownReport && (
                 <button onClick={saveReportToWorkspace} className="flex items-center space-x-2 bg-black hover:bg-slate-700 text-slate-300 px-3 py-1 rounded-none text-[10px] font-bold border border-[var(--industrial-border)] transition-all shadow-sm uppercase tracking-widest">
                   <FolderOpen size={12} />
                   <span>Save Report</span>
                 </button>
               )}
               {state.jsonData && (
                 <button onClick={saveModelToWorkspace} className="flex items-center space-x-2 bg-[var(--industrial-accent)] hover:bg-[var(--industrial-accent-muted)] text-white px-3 py-1 rounded-none text-[10px] font-bold border border-[var(--industrial-accent)]/30 transition-all shadow-lg uppercase tracking-widest">
                   <Save size={12} />
                   <span>Commit JSON</span>
                 </button>
               )}
               {state.tdbData && (
                 <button onClick={saveTDBToWorkspace} className="flex items-center space-x-2 bg-[var(--industrial-accent)] hover:bg-[var(--industrial-accent-muted)] text-white px-3 py-1 rounded-none text-[10px] font-bold border border-[var(--industrial-accent)]/30 transition-all shadow-lg uppercase tracking-widest">
                   <Save size={12} />
                   <span>Commit TDB</span>
                 </button>
               )}
             </div>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar bg-black">
            {isProcessing ? (
              <div className="h-full flex flex-col items-center justify-center space-y-8 p-12">
                <div className="w-20 h-20 border-4 border-[var(--industrial-border)] border-t-[var(--industrial-accent)] rounded-full animate-spin" />
                <p className="text-xs font-bold uppercase tracking-widest text-slate-500 animate-pulse">Scanning thermodynamic context...</p>
              </div>
            ) : state.markdownReport ? (
              <div className="p-10 space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-700 max-w-4xl mx-auto">
                <div className="prose prose-invert prose-sm max-w-none">
                  <style>{`
                    .report-container table { width: 100%; border-collapse: collapse; margin: 2rem 0; font-size: 0.75rem; border-radius: 0; overflow: hidden; background: black; }
                    .report-container th { background: #111; color: #f8fafc; text-align: left; padding: 1rem; border: 1px solid var(--industrial-border); text-transform: uppercase; font-size: 0.6rem; letter-spacing: 0.1em; }
                    .report-container td { padding: 1rem; border: 1px solid var(--industrial-border); color: #cbd5e1; font-family: var(--font-mono); }
                    .report-container h4 { color: var(--industrial-accent); border-left: 4px solid var(--industrial-accent); padding-left: 1rem; margin-top: 3.5rem; margin-bottom: 1rem; font-weight: 800; text-transform: uppercase; font-size: 0.9rem; }
                    .report-container blockquote { border-left: 4px solid var(--industrial-accent); padding: 1rem 2rem; margin: 2rem 0; background: black; }
                  `}</style>
                  <div className="report-container bg-black p-10 rounded-none border border-[var(--industrial-border)] shadow-2xl relative overflow-hidden backdrop-blur-md">
                    <div className="absolute top-0 left-0 w-full h-1.5 bg-[var(--industrial-accent)]" />
                    <div className="relative z-10 whitespace-pre-wrap font-sans" dangerouslySetInnerHTML={{ __html: formatMarkdown(state.markdownReport) }} />
                  </div>
                </div>
                {state.jsonData && (
                  <div className="space-y-6">
                    <h4 className="text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--industrial-accent)]/90 flex items-center px-4">
                      <FileJson className="mr-3 w-5 h-5" /> ESPEI STRUCTURAL SCHEMA
                    </h4>
                    <pre className="bg-black border border-[var(--industrial-border)] rounded-none p-8 text-[12px] text-[var(--industrial-accent)]/90 font-mono overflow-x-auto shadow-2xl custom-scrollbar">
                      {state.jsonData}
                    </pre>
                  </div>
                )}
                {state.tdbData && (
                  <div className="space-y-6">
                    <h4 className="text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--industrial-accent)]/90 flex items-center px-4">
                      <Database className="mr-3 w-5 h-5" /> TDB DATABASE SOURCE
                    </h4>
                    <pre className="bg-black border border-[var(--industrial-border)] rounded-none p-8 text-[12px] text-emerald-500/90 font-mono overflow-x-auto shadow-2xl custom-scrollbar">
                      {state.tdbData}
                    </pre>
                  </div>
                )}
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center p-12 opacity-30 text-center">
                <FileText size={42} className="text-slate-700 mb-6" />
                <p className="text-xs font-bold uppercase tracking-[0.4em] text-slate-500">Session Idle</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

function formatMarkdown(text: string): string {
  let html = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/^#### (.*$)/gim, '<h4>$1</h4>');
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^> (.*$)/gim, '<blockquote>$1</blockquote>');
  
  const lines = html.split('\n');
  let inTable = false;
  let tableHtml = '';
  const resultLines: string[] = [];
  
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const actualCells = trimmed.split('|').slice(1, -1).map(c => c.trim());
      if (!inTable) {
        inTable = true;
        tableHtml = '<table><thead><tr>';
        actualCells.forEach(c => { tableHtml += `<th>${c}</th>`; });
        tableHtml += '</tr></thead><tbody>';
      } else if (!trimmed.includes('---')) {
        tableHtml += '<tr>';
        actualCells.forEach(c => { tableHtml += `<td>${c}</td>`; });
        tableHtml += '</tr>';
      }
    } else {
      if (inTable) {
        inTable = false;
        resultLines.push(tableHtml + '</tbody></table>');
        tableHtml = '';
      }
      resultLines.push(line);
    }
  });
  if (inTable) resultLines.push(tableHtml + '</tbody></table>');
  return resultLines.join('\n');
}

export default LiteratureAgent;
