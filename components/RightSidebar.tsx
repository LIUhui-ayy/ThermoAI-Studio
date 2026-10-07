
import React, { useState, useRef, useEffect } from 'react';
import { FileNode } from '../types';
import { 
  Folder, 
  FileCode, 
  Plus, 
  FolderPlus, 
  Search, 
  ChevronDown, 
  ChevronRight,
  Database,
  FileJson,
  FileSpreadsheet,
  FileText,
  Trash2,
  Download,
  Loader2,
  Check,
  AlertTriangle,
  X,
  Edit3,
  Upload,
  FolderUp
} from 'lucide-react';
import JSZip from 'jszip';

interface RightSidebarProps {
  files: FileNode[];
  setFiles: React.Dispatch<React.SetStateAction<FileNode[]>>;
  onFileSelect: (path: string) => void;
  onFileEdit: (path: string) => void;
  activeFilePath: string | null;
  onDeleteFile: (id: string, path: string) => void;
}

const RightSidebar: React.FC<RightSidebarProps> = ({ files, setFiles, onFileSelect, onFileEdit, activeFilePath, onDeleteFile }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isDownloading, setIsDownloading] = useState<string | null>(null);
  const [namingState, setNamingState] = useState<{ parentId: string | null, type: 'file' | 'folder' } | null>(null);
  
  // Custom Modal State
  const [itemToDelete, setItemToDelete] = useState<{ id: string; path: string; name: string } | null>(null);

  // Import Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const handleFileImportClick = () => fileInputRef.current?.click();
  const handleFolderImportClick = () => folderInputRef.current?.click();

  const processImportedFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    
    const filesArray = Array.from(fileList);
    
    // Read all files
    const fileContents = await Promise.all(filesArray.map(async (file) => {
      const isBinary = file.name.endsWith('.npy');
      const content = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target?.result as string || '');
        if (isBinary) {
          reader.readAsDataURL(file);
        } else {
          reader.readAsText(file);
        }
      });
      return {
        file,
        content,
        // webkitRelativePath is for folder upload, name is for file upload
        path: file.webkitRelativePath || file.name
      };
    }));

    setFiles(prev => {
      // Deep clone to avoid mutation issues
      const newFiles = JSON.parse(JSON.stringify(prev));
      
      // Find root node (assuming first node is root)
      const root = newFiles[0];
      if (!root || !root.children) return prev;

      fileContents.forEach(({ content, path }) => {
        const pathParts = path.split('/');
        
        // Start traversal from root
        let currentLevel = root.children;
        let currentPath = root.path === '/' ? '' : root.path;
        let parentId = root.id;

        pathParts.forEach((part: string, index: number) => {
          const isFile = index === pathParts.length - 1;
          const fullPath = `${currentPath}/${part}`;
          
          let existingNode = currentLevel.find((n: FileNode) => n.name === part);
          
          if (existingNode) {
            if (isFile) {
               // Update content if file exists
               if (existingNode.type === 'file') {
                 existingNode.content = content;
               }
            } else {
               // It's a folder, continue traversal
               if (existingNode.type === 'folder') {
                 if (!existingNode.children) existingNode.children = [];
                 currentLevel = existingNode.children;
                 parentId = existingNode.id;
                 currentPath = existingNode.path;
               }
            }
          } else {
            // Create new node
            const newNode: FileNode = {
              id: Math.random().toString(36).substr(2, 9),
              name: part,
              type: isFile ? 'file' : 'folder',
              path: fullPath,
              children: isFile ? undefined : [],
              content: isFile ? content : '',
              parentId: parentId
            };
            
            currentLevel.push(newNode);
            
            if (!isFile) {
              currentLevel = newNode.children!;
              parentId = newNode.id;
              currentPath = newNode.path;
            }
          }
        });
      });
      
      return newFiles;
    });
    
    // Reset inputs
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (folderInputRef.current) folderInputRef.current.value = '';
  };

  const addItem = (parentId: string | null, type: 'file' | 'folder', name: string) => {
    if (!name.trim()) {
      setNamingState(null);
      return;
    }

    setFiles(prev => {
      const newFiles = JSON.parse(JSON.stringify(prev)) as FileNode[];
      
      const findAndAdd = (nodes: FileNode[]): boolean => {
        for (let node of nodes) {
          if (node.id === parentId && node.type === 'folder') {
            const newNode: FileNode = {
              id: Math.random().toString(36).substr(2, 9),
              name,
              type,
              path: `${node.path === '/' ? '' : node.path}/${name}`,
              children: type === 'folder' ? [] : undefined,
              content: '',
              parentId: node.id
            };
            node.children = [...(node.children || []), newNode];
            return true;
          }
          if (node.children && findAndAdd(node.children)) return true;
        }
        return false;
      };

      if (parentId) {
        if (findAndAdd(newFiles)) return newFiles;
      }

      const root = newFiles[0];
      if (root) {
        const newNode: FileNode = {
          id: Math.random().toString(36).substr(2, 9),
          name, 
          type, 
          path: `${root.path === '/' ? '' : root.path}/${name}`, 
          children: type === 'folder' ? [] : undefined, 
          content: '', 
          parentId: root.id
        };
        root.children = [...(root.children || []), newNode];
      }
      return newFiles;
    });
    setNamingState(null);
  };

  const handleDownloadFile = (node: FileNode) => {
    if (node.name.endsWith('.npy') && (node.content?.startsWith('data:') || node.content?.startsWith('blob:'))) {
      const link = document.createElement('a');
      link.href = node.content;
      link.download = node.name;
      link.click();
    } else {
      const blob = new Blob([node.content || ''], { type: 'text/plain' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = node.name;
      link.click();
      window.URL.revokeObjectURL(url);
    }
  };

  const handleDownloadFolder = async (folderNode: FileNode) => {
    setIsDownloading(folderNode.id);
    const zip = new JSZip();

    const addToZip = async (node: FileNode, currentZipFolder: JSZip) => {
      if (node.type === 'file') {
        if (node.name.endsWith('.npy') && node.content?.startsWith('data:')) {
          const b64Data = node.content.split('base64,')[1];
          currentZipFolder.file(node.name, b64Data || '', { base64: true });
        } else if (node.name.endsWith('.npy') && node.content?.startsWith('blob:')) {
          try {
            const res = await fetch(node.content);
            const blob = await res.blob();
            currentZipFolder.file(node.name, blob);
          } catch (e) {
            console.error("Failed to fetch blob for zip", e);
          }
        } else {
          currentZipFolder.file(node.name, node.content || '');
        }
      } else if (node.type === 'folder' && node.children) {
        const subFolder = currentZipFolder.folder(node.name);
        if (subFolder) {
          for (const child of node.children) {
            await addToZip(child, subFolder);
          }
        }
      }
    };

    // If it's the root or a specific folder, we want its contents
    if (folderNode.children) {
      for (const child of folderNode.children) {
        await addToZip(child, zip);
      }
    }

    try {
      const content = await zip.generateAsync({ type: 'blob' });
      const url = window.URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${folderNode.name}.zip`;
      link.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error("ZIP Generation Error", err);
    } finally {
      setIsDownloading(null);
    }
  };

  const confirmDelete = () => {
    if (itemToDelete) {
      onDeleteFile(itemToDelete.id, itemToDelete.path);
      setItemToDelete(null);
    }
  };

  return (
    <>
      <aside className="w-72 flex flex-col bg-black border-l border-[var(--industrial-border)] z-10 shadow-[-4px_0_24px_rgba(0,0,0,0.5)]">
        <div className="h-14 border-b border-[var(--industrial-border)] flex items-center px-4 justify-between bg-black">
          <div className="flex items-center space-x-2">
            <Database className="w-4 h-4 text-[var(--industrial-accent)]" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Resource Hub</span>
          </div>
          <div className="flex space-x-1">
            <button onClick={handleFileImportClick} className="p-1.5 hover:bg-black rounded-none text-slate-500 hover:text-[var(--industrial-accent)]" title="Import File(s)"><Upload size={14} /></button>
            <button onClick={handleFolderImportClick} className="p-1.5 hover:bg-black rounded-none text-slate-500 hover:text-[var(--industrial-accent)]" title="Import Folder"><FolderUp size={14} /></button>
            <div className="w-px h-4 bg-[var(--industrial-border)] mx-1 self-center" />
            <button onClick={() => setNamingState({ parentId: null, type: 'file' })} className="p-1.5 hover:bg-black rounded-none text-slate-500 hover:text-[var(--industrial-accent)]" title="New Root File"><Plus size={14} /></button>
            <button onClick={() => setNamingState({ parentId: null, type: 'folder' })} className="p-1.5 hover:bg-black rounded-none text-slate-500 hover:text-[var(--industrial-accent)]" title="New Root Folder"><FolderPlus size={14} /></button>
          </div>
        </div>

        <div className="p-3">
          <input 
            type="text" 
            placeholder="Search resources..." 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-black border border-[var(--industrial-border)] rounded-none py-1.5 px-3 text-[11px] text-slate-300 focus:outline-none focus:border-[var(--industrial-accent)]/50 font-mono" 
          />
        </div>

        <div className="flex-1 overflow-y-auto px-2 space-y-0.5 custom-scrollbar pb-10">
          {files.map(node => (
            <FileTreeItem 
              key={node.id} 
              node={node} 
              level={0} 
              onSelect={onFileSelect} 
              onEdit={onFileEdit}
              onDeleteInitiate={(id, path, name) => setItemToDelete({ id, path, name })}
              onDownloadFolder={handleDownloadFolder}
              onDownloadFile={handleDownloadFile}
              onAddItem={addItem}
              isDownloading={isDownloading === node.id}
              activePath={activeFilePath}
              namingState={namingState}
              setNamingState={setNamingState}
            />
          ))}
          {namingState?.parentId === null && (
            <InlineNamingInput level={1} type={namingState.type} onConfirm={(n) => addItem(null, namingState.type, n)} onCancel={() => setNamingState(null)} />
          )}
        </div>

        <div className="p-4 border-t border-[var(--industrial-border)] bg-black">
          <div className="text-[9px] font-bold text-slate-600 uppercase tracking-widest mb-1">Context</div>
          <div className="bg-black rounded-none p-2 text-[10px] font-mono text-[var(--industrial-accent)] truncate border border-[var(--industrial-border)]/50">
            {activeFilePath || 'ROOT'}
          </div>
        </div>
      </aside>

      {itemToDelete && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-6 bg-black backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-black border border-[var(--industrial-border)] rounded-none p-8 w-full max-w-sm shadow-2xl animate-in zoom-in-95 duration-200 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-red-600/50" />
            <div className="flex flex-col items-center text-center space-y-4">
              <div className="p-3 bg-red-600/10 text-red-500 rounded-none">
                <AlertTriangle size={28} />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white tracking-tight leading-none mb-2 uppercase">Delete Resource?</h3>
                <p className="text-xs text-slate-400 leading-relaxed font-mono">
                  Are you sure you want to permanently destroy <span className="text-[var(--industrial-accent)] font-bold">"{itemToDelete.name}"</span>? 
                  This action will also remove all nested contents and cannot be undone.
                </p>
              </div>
              <div className="flex w-full space-x-3 pt-4">
                <button onClick={() => setItemToDelete(null)} className="flex-1 px-4 py-2.5 rounded-none text-xs font-bold text-slate-400 bg-black hover:bg-slate-900 transition-all uppercase tracking-widest border border-[var(--industrial-border)]">Cancel</button>
                <button onClick={confirmDelete} className="flex-1 bg-red-600 hover:bg-red-500 text-white rounded-none py-2.5 text-xs font-bold shadow-xl transition-all uppercase tracking-widest">Delete</button>
              </div>
            </div>
            <button onClick={() => setItemToDelete(null)} className="absolute top-4 right-4 text-slate-600 hover:text-slate-400"><X size={16} /></button>
          </div>
        </div>
      )}

      {/* Hidden Inputs for Import */}
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={(e) => processImportedFiles(e.target.files)} 
        className="hidden" 
        multiple 
      />
      <input 
        type="file" 
        ref={folderInputRef} 
        onChange={(e) => processImportedFiles(e.target.files)} 
        className="hidden" 
        {...({webkitdirectory: "", directory: ""} as any)} 
      />
    </>
  );
};

const FileTreeItem: React.FC<{ 
  node: FileNode, level: number, 
  onSelect: (path: string) => void, 
  onEdit: (path: string) => void,
  onDeleteInitiate: (id: string, path: string, name: string) => void,
  onDownloadFolder: (node: FileNode) => void, 
  onDownloadFile: (node: FileNode) => void,
  onAddItem: (p: string, t: 'file' | 'folder', n: string) => void,
  isDownloading: boolean, activePath: string | null,
  namingState: any, setNamingState: any
}> = ({ node, level, onSelect, onEdit, onDeleteInitiate, onDownloadFolder, onDownloadFile, onAddItem, isDownloading, activePath, namingState, setNamingState }) => {
  const [isOpen, setIsOpen] = useState(true);
  const isActive = activePath === node.path;

  const getFileIcon = (name: string) => {
    if (name.endsWith('.json')) return <FileJson className="w-3.5 h-3.5 mr-2 text-amber-500/70" />;
    if (name.endsWith('.csv')) return <FileSpreadsheet className="w-3.5 h-3.5 mr-2 text-emerald-500/70" />;
    if (name.endsWith('.md')) return <FileText className="w-3.5 h-3.5 mr-2 text-slate-500" />;
    return <FileCode className="w-3.5 h-3.5 mr-2 text-blue-500/70" />;
  };

  const isEditable = (name: string) => {
    const ext = name.split('.').pop()?.toLowerCase();
    return ['json', 'tdb', 'log', 'yaml', 'yml', 'txt', 'md', 'csv'].includes(ext || '');
  };

  return (
    <div className="animate-in fade-in slide-in-from-left-1 duration-200">
      <div 
        className={`flex items-center py-1.5 px-2 rounded-none cursor-pointer group transition-all text-xs border border-transparent ${isActive ? 'bg-[var(--industrial-accent)]/10 border-[var(--industrial-accent)]/30 text-[var(--industrial-accent)]' : 'text-slate-500 hover:bg-slate-900 hover:text-slate-300'}`}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
        onClick={() => {
          if (node.type === 'folder') setIsOpen(!isOpen);
          onSelect(node.path);
        }}
      >
        <span className="mr-1">
          {node.type === 'folder' ? (isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : <span className="w-3 block" />}
        </span>
        {node.type === 'folder' ? <Folder className={`w-3.5 h-3.5 mr-2 text-[var(--industrial-accent)]/50`} /> : getFileIcon(node.name)}
        <span className="flex-1 truncate font-mono">{node.name}</span>
        
        <div className="opacity-0 group-hover:opacity-100 flex items-center space-x-1 ml-2 transition-opacity">
          {/* Download Button */}
          <button 
            onClick={(e) => { 
              e.stopPropagation(); 
              node.type === 'folder' ? onDownloadFolder(node) : onDownloadFile(node); 
            }} 
            className="p-1 hover:text-[var(--industrial-accent)] transition-colors" 
            title={node.type === 'folder' ? "Pack as ZIP" : "Download File"}
          >
            {isDownloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
          </button>

          {node.type === 'file' && isEditable(node.name) && (
            <button 
              onClick={(e) => { e.stopPropagation(); onEdit(node.path); }} 
              className="p-1 hover:text-[var(--industrial-accent)] transition-colors" 
              title="Edit File"
            >
              <Edit3 size={12} />
            </button>
          )}

          {node.type === 'folder' && (
            <>
              <button onClick={(e) => { e.stopPropagation(); setIsOpen(true); setNamingState({ parentId: node.id, type: 'folder' }); }} className="p-1 hover:text-[var(--industrial-accent)] transition-colors" title="New Subfolder"><FolderPlus size={12} /></button>
              <button onClick={(e) => { e.stopPropagation(); setIsOpen(true); setNamingState({ parentId: node.id, type: 'file' }); }} className="p-1 hover:text-[var(--industrial-accent)] transition-colors" title="New File"><Plus size={12} /></button>
            </>
          )}
          
          {node.id !== 'root' && (
            <button onClick={(e) => { e.stopPropagation(); onDeleteInitiate(node.id, node.path, node.name); }} className="p-1 hover:text-red-500 transition-colors" title="Delete">
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>

      {node.type === 'folder' && isOpen && (
        <div className="relative">
          <div className="absolute left-[14px] top-0 bottom-0 w-px bg-[#1a1a1a]/30" style={{ left: `${level * 12 + 14}px` }} />
          {namingState?.parentId === node.id && (
            <InlineNamingInput level={level + 1} type={namingState.type} onConfirm={(n) => onAddItem(node.id, namingState.type, n)} onCancel={() => setNamingState(null)} />
          )}
          {node.children && node.children.map(child => (
            <FileTreeItem 
              key={child.id} node={child} level={level + 1} onSelect={onSelect} onEdit={onEdit} onDeleteInitiate={onDeleteInitiate} 
              onDownloadFolder={onDownloadFolder} onDownloadFile={onDownloadFile} onAddItem={onAddItem} isDownloading={isDownloading} activePath={activePath} 
              namingState={namingState} setNamingState={setNamingState} 
            />
          ))}
        </div>
      )}
    </div>
  );
};

const InlineNamingInput: React.FC<{ level: number, type: 'file' | 'folder', onConfirm: (n: string) => void, onCancel: () => void }> = ({ level, type, onConfirm, onCancel }) => {
  const [val, setVal] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const handleBlur = () => { setTimeout(() => { if (!val) onCancel(); }, 150); };
  return (
    <div className="flex items-center py-1.5 px-2 bg-[var(--industrial-accent)]/10 rounded-none border border-[var(--industrial-accent)]/20 my-0.5 animate-in slide-in-from-left-2 duration-200" style={{ marginLeft: `${level * 12 + 8}px`, marginRight: '8px' }}>
      <div className="shrink-0 mr-2">{type === 'folder' ? <Folder className="w-3.5 h-3.5 text-[var(--industrial-accent)]" /> : <FileCode className="w-3.5 h-3.5 text-blue-400" />}</div>
      <input ref={inputRef} value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if(e.key === 'Enter') onConfirm(val); if(e.key === 'Escape') onCancel(); }} onBlur={handleBlur} placeholder={type === 'folder' ? 'Folder name' : 'Filename.json'} className="flex-1 bg-transparent text-xs text-[var(--industrial-accent)] outline-none p-0 focus:ring-0 placeholder:text-slate-600 font-mono" />
      <button onMouseDown={(e) => { e.preventDefault(); onConfirm(val); }} className="ml-1 p-0.5 text-emerald-500 hover:text-emerald-400 transition-colors"><Check size={14} /></button>
      <button onMouseDown={(e) => { e.preventDefault(); onCancel(); }} className="ml-0.5 p-0.5 text-slate-600 hover:text-slate-400 transition-colors"><X size={14} /></button>
    </div>
  );
};

export default RightSidebar;
