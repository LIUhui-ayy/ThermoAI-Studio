
import React from 'react';
import { X, FileCode, FileText, Download, Copy, Maximize2 } from 'lucide-react';
import { FileNode } from '../types';

interface PreviewModalProps {
  file: FileNode;
  onClose: () => void;
}

const PreviewModal: React.FC<PreviewModalProps> = ({ file, onClose }) => {
  const isJson = file.name.endsWith('.json');
  const isMd = file.name.endsWith('.md');
  const isPdf = file.name.endsWith('.pdf');
  const isImage = /\.(png|jpe?g|gif|svg|webp)$/i.test(file.name) || (file.content?.startsWith('data:image/'));

  const handleCopy = () => {
    if (file.content) {
      navigator.clipboard.writeText(file.content);
      alert('Content copied to clipboard.');
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-8 animate-in fade-in duration-300">
      <div className="bg-black border border-[var(--industrial-border)] w-full max-w-5xl h-full rounded-none shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-300">
        
        {/* Modal Header */}
        <div className="h-16 border-b border-[var(--industrial-border)] px-8 flex items-center justify-between shrink-0 bg-black">
          <div className="flex items-center space-x-4">
            <div className={`p-2.5 rounded-none ${isJson ? 'bg-amber-600/20 text-amber-500' : 'bg-[var(--industrial-accent)]/20 text-[var(--industrial-accent)]'}`}>
              {isJson ? <FileCode size={20} /> : <FileText size={20} />}
            </div>
            <div>
              <h2 className="text-sm font-bold text-white uppercase tracking-tight">{file.name}</h2>
              <p className="text-[10px] text-slate-500 font-mono tracking-tighter uppercase">{file.path}</p>
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <button onClick={handleCopy} className="p-2 hover:bg-slate-800 rounded-none text-slate-400 hover:text-white transition-colors" title="Copy Content">
              <Copy size={18} />
            </button>
            <button className="p-2 hover:bg-slate-800 rounded-none text-slate-400 hover:text-white transition-colors">
              <Download size={18} />
            </button>
            <div className="w-px h-6 bg-slate-800 mx-2" />
            <button onClick={onClose} className="p-2 hover:bg-red-600/20 rounded-none text-slate-400 hover:text-red-500 transition-colors">
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Modal Content */}
        <div className="flex-1 overflow-auto bg-black p-8 custom-scrollbar">
          {isImage ? (
            <div className="h-full flex items-center justify-center">
              <img 
                src={file.content} 
                alt={file.name} 
                className="max-w-full max-h-full object-contain shadow-2xl rounded-none"
              />
            </div>
          ) : isPdf ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-600 space-y-4">
              <Maximize2 size={48} className="opacity-10" />
              <p className="italic text-sm">PDF viewer integration for File Hub is limited to the Literature Agent reader. Please open this file there.</p>
            </div>
          ) : isJson ? (
            <pre className="text-xs font-mono text-amber-500/90 leading-relaxed whitespace-pre-wrap">
              {JSON.stringify(JSON.parse(file.content || '{}'), null, 2)}
            </pre>
          ) : (
            <div className="prose prose-invert prose-sm max-w-none">
               <pre className="text-xs font-mono text-slate-400 leading-relaxed whitespace-pre-wrap bg-transparent border-none p-0">
                 {file.content}
               </pre>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="h-12 border-t border-[var(--industrial-border)] px-8 flex items-center justify-between shrink-0 bg-black">
          <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">
            {isJson ? 'Structural Modality' : 'Textual Information'} Read-Only
          </div>
          <button onClick={onClose} className="text-[10px] font-bold text-[var(--industrial-accent)] hover:text-[var(--industrial-accent-muted)] uppercase tracking-widest">
            Close Preview
          </button>
        </div>
      </div>
    </div>
  );
};

export default PreviewModal;
