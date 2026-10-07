
import React, { useState, useEffect } from 'react';
import { X, Save, FileCode, Check, AlertCircle, Sparkles, Undo2 } from 'lucide-react';
import { FileNode } from '../types';

interface FileEditorModalProps {
  file: FileNode;
  onSave: (id: string, content: string) => void;
  onClose: () => void;
}

const FileEditorModal: React.FC<FileEditorModalProps> = ({ file, onSave, onClose }) => {
  const [content, setContent] = useState(file.content || '');
  const [error, setError] = useState<string | null>(null);
  const [isSaved, setIsSaved] = useState(false);

  const isJson = file.name.endsWith('.json');
  const isBinaryBase64 = content.startsWith('data:') && content.includes('base64');

  const handleSave = () => {
    if (isBinaryBase64) {
      setError("Cannot save edits to binary base64 artifacts in the text editor.");
      return;
    }
    if (isJson) {
      try {
        if (content.trim()) {
          JSON.parse(content);
        }
        setError(null);
      } catch (e: any) {
        setError(`Invalid JSON: ${e.message}`);
        return;
      }
    }
    
    onSave(file.id, content);
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2000);
  };

  const handleBeautify = () => {
    if (!isJson) return;
    try {
      const parsed = JSON.parse(content);
      setContent(JSON.stringify(parsed, null, 2));
      setError(null);
    } catch (e: any) {
      setError(`Cannot beautify invalid JSON: ${e.message}`);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-8 animate-in fade-in duration-300">
      <div className="bg-black border border-[var(--industrial-border)] w-full max-w-6xl h-full rounded-none shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-300">
        
        {/* Editor Header */}
        <div className="h-16 border-b border-[var(--industrial-border)] px-8 flex items-center justify-between shrink-0 bg-black">
          <div className="flex items-center space-x-4">
            <div className="p-2.5 rounded-none bg-[var(--industrial-accent)]/20 text-[var(--industrial-accent)]">
              <FileCode size={20} />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h2 className="text-sm font-bold text-white uppercase tracking-tight">Editing: {file.name}</h2>
                <span className="px-2 py-0.5 bg-slate-800 rounded-none text-[9px] text-slate-500 font-bold uppercase tracking-widest border border-slate-700">Editor</span>
              </div>
              <p className="text-[10px] text-slate-500 font-mono tracking-tighter uppercase">{file.path}</p>
            </div>
          </div>
          
          <div className="flex items-center space-x-3">
            {isJson && (
              <button 
                onClick={handleBeautify}
                className="flex items-center space-x-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-none text-[10px] font-bold border border-slate-700 transition-all uppercase tracking-widest"
                title="Format JSON"
              >
                <Sparkles size={14} />
                <span>Beautify</span>
              </button>
            )}
            <div className="w-px h-6 bg-slate-800 mx-2" />
            <button 
              onClick={handleSave}
              className={`flex items-center space-x-2 px-6 py-2 rounded-none text-[10px] font-bold transition-all uppercase tracking-widest shadow-xl ${
                isSaved ? 'bg-emerald-600 text-white' : 'bg-[var(--industrial-accent)] hover:bg-[var(--industrial-accent-muted)] text-black'
              }`}
            >
              {isSaved ? <Check size={14} /> : <Save size={14} />}
              <span>{isSaved ? 'Saved' : 'Save Changes'}</span>
            </button>
            <button 
              onClick={onClose} 
              className="p-2 hover:bg-red-600/20 rounded-none text-slate-400 hover:text-red-500 transition-colors"
              title="Close Editor"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Editor Body */}
        <div className="flex-1 flex flex-col overflow-hidden bg-black relative">
          {error && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-top-2">
              <div className="bg-red-900/40 border border-red-500/50 backdrop-blur-md px-6 py-3 rounded-none flex items-center space-x-3 text-red-400 shadow-2xl">
                <AlertCircle size={18} />
                <span className="text-[11px] font-bold uppercase tracking-widest">{error}</span>
              </div>
            </div>
          )}

          {isBinaryBase64 ? (
            <div className="flex-1 w-full h-full bg-transparent p-10 flex items-center justify-center text-[13px] font-mono text-[var(--industrial-accent)]/50">
              <div className="text-center">
                <FileCode size={48} className="mx-auto mb-4 opacity-50" />
                <p className="uppercase tracking-widest font-bold">Binary Artifact (Base64)</p>
                <p className="mt-2 text-[10px] text-slate-500 max-w-sm mx-auto">This file contains raw binary data that exceeds the limitations of the text editor. You can download this file directly from the Resource Explorer.</p>
              </div>
            </div>
          ) : (
            <textarea
              className="flex-1 w-full h-full bg-transparent p-10 text-[13px] font-mono text-[var(--industrial-accent)]/80 outline-none resize-none leading-relaxed custom-scrollbar selection:bg-[var(--industrial-accent)]/30"
              spellCheck={false}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="// Enter thermodynamic data or code here..."
            />
          )}
        </div>

        {/* Editor Footer */}
        <div className="h-12 border-t border-[var(--industrial-border)] px-8 flex items-center justify-between shrink-0 bg-black">
          <div className="flex items-center space-x-6 text-[10px] font-bold uppercase tracking-widest text-slate-500">
            <div className="flex items-center space-x-2">
              <span className="text-slate-700">Status:</span>
              <span className="text-[var(--industrial-accent)]">Live Workspace Editor</span>
            </div>
          </div>
          <button onClick={onClose} className="flex items-center space-x-2 text-[10px] font-bold text-slate-600 hover:text-slate-400 uppercase tracking-widest transition-colors">
            <Undo2 size={12} />
            <span>Discard & Close</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default FileEditorModal;
