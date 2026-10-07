import React, { useState } from 'react';
import { X, Check, Folder, File, ChevronRight, ChevronDown } from 'lucide-react';
import { FileNode } from '../types';

interface FileSelectorModalProps {
  files: FileNode[];
  mode: 'file' | 'folder';
  title: string;
  onClose: () => void;
  onConfirm: (path: string) => void;
}

const FileSelectorModal: React.FC<FileSelectorModalProps> = ({ files, mode, title, onClose, onConfirm }) => {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['root']));

  const toggleFolder = (id: string) => {
    const newExpanded = new Set(expandedFolders);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedFolders(newExpanded);
  };

  const renderTree = (nodes: FileNode[], depth = 0) => {
    return nodes.map(node => {
      const isExpanded = expandedFolders.has(node.id);
      const isSelected = selectedPath === node.path;
      const isSelectable = mode === 'file' ? node.type === 'file' : node.type === 'folder';

      return (
        <div key={node.id}>
          <div 
            className={`flex items-center py-1 px-2 cursor-pointer transition-colors rounded-none ${
              isSelected ? 'bg-[var(--industrial-accent)]/20 text-[var(--industrial-accent)]' : 'hover:bg-slate-800/50 text-slate-400'
            }`}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            onClick={() => {
              if (node.type === 'folder') toggleFolder(node.id);
              if (isSelectable) setSelectedPath(node.path);
            }}
          >
            <div className="mr-2">
              {node.type === 'folder' ? (
                <div className="flex items-center">
                    {isExpanded ? <ChevronDown size={12} className="mr-1" /> : <ChevronRight size={12} className="mr-1" />}
                    <Folder size={14} className={isSelected ? 'text-[var(--industrial-accent)]' : 'text-slate-500'} />
                </div>
              ) : (
                <File size={14} className="ml-4" />
              )}
            </div>
            <span className="text-xs font-mono truncate">{node.name}</span>
          </div>
          {node.type === 'folder' && isExpanded && node.children && (
            <div>{renderTree(node.children, depth + 1)}</div>
          )}
        </div>
      );
    });
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black backdrop-blur-sm p-8 animate-in fade-in duration-200">
      <div className="bg-black border border-[var(--industrial-border)] w-full max-w-md rounded-none shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
        
        <div className="h-12 border-b border-[var(--industrial-border)] px-4 flex items-center justify-between shrink-0 bg-black">
          <h3 className="text-xs font-bold text-white uppercase tracking-widest">{title}</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
            {renderTree(files)}
        </div>

        <div className="p-4 border-t border-[var(--industrial-border)] bg-black flex justify-end space-x-3">
            <button 
                onClick={onClose}
                className="px-4 py-2 rounded-none text-xs font-bold text-slate-500 hover:text-white uppercase tracking-wider transition-colors"
            >
                Cancel
            </button>
            <button 
                onClick={() => selectedPath && onConfirm(selectedPath)}
                disabled={!selectedPath}
                className={`px-4 py-2 rounded-none text-xs font-bold uppercase tracking-wider transition-colors flex items-center space-x-2 ${
                    selectedPath 
                    ? 'bg-[var(--industrial-accent)] hover:bg-[var(--industrial-accent-muted)] text-black shadow-lg shadow-[var(--industrial-accent)]/20' 
                    : 'bg-[#222] text-slate-600 cursor-not-allowed'
                }`}
            >
                <Check size={14} />
                <span>Confirm Selection</span>
            </button>
        </div>

      </div>
    </div>
  );
};

export default FileSelectorModal;
