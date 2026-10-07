
import React, { useState, useEffect, useCallback } from 'react';
import { 
  FileSearch, 
  Settings, 
  BarChart3, 
  Cpu, 
  ChevronRight, 
  BrainCircuit,
  Boxes,
  Tag,
  Zap,
  Target
} from 'lucide-react';
import { AppTab, FileNode, JobStatus, ESPEIConfig, LiteratureState } from './types';
import { DEFAULT_CONFIG } from './constants';
import LiteratureAgent from './components/LiteratureAgent';
import StructuringStudio from './components/StructuringStudio';
import Wizard from './components/Wizard';
import AdvancedOptimization from './components/AdvancedOptimization';
import UncertaintyAnalysis from './components/UncertaintyAnalysis';
import Monitor from './components/Monitor';
import Analysis from './components/Analysis';
import RightSidebar from './components/RightSidebar';
import PreviewModal from './components/PreviewModal';
import FileEditorModal from './components/FileEditorModal';

const INITIAL_FILES: FileNode[] = [
  {
    id: 'root',
    name: 'Thermo_Workspace',
    type: 'folder',
    path: '/',
    children: [
      { id: '1', name: 'extracted_data', type: 'folder', path: '/extracted_data', children: [] },
      { id: '2', name: 'espei_datasets', type: 'folder', path: '/espei_datasets', children: [] },
      { id: '3', name: 'models', type: 'folder', path: '/models', children: [] },
      { id: '4', name: 'uploads', type: 'folder', path: '/uploads', children: [] }
    ]
  }
];

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<AppTab>(AppTab.LITERATURE);
  const [files, setFiles] = useState<FileNode[]>(INITIAL_FILES);
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [currentConfig, setCurrentConfig] = useState<ESPEIConfig>(DEFAULT_CONFIG);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  
  // Global Preview & Editor State
  const [previewFile, setPreviewFile] = useState<FileNode | null>(null);
  const [editingFile, setEditingFile] = useState<FileNode | null>(null);

  // Literature Agent Persistent State
  const [literatureState, setLiteratureState] = useState<LiteratureState>({
    file: null,
    fileUrl: null,
    markdownReport: null,
    jsonData: null,
    tdbData: null,
    numPages: 0,
    pageNumber: 1,
    pdfScale: 1.1
  });

  // Load from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('thermo-ai-files');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && Array.isArray(parsed)) {
          setFiles(parsed);
        }
      } catch (e) {
        console.error("Failed to load workspace files", e);
      }
    }
  }, []);

  // Centralized Sync to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('thermo-ai-files', JSON.stringify(files));
    } catch (e) {
      console.warn("localStorage quota exceeded, stripping large binary contents before saving...");
      try {
        const stripLargeBinaries = (nodes: FileNode[]): FileNode[] => {
          return nodes.map(node => {
            const stripped = { ...node };
            if (stripped.name.endsWith('.npy') || (stripped.content && stripped.content.length > 1000000)) {
               stripped.content = `data:text/plain;charset=utf-8,File too large for local cache (${Math.round((stripped.content?.length || 0)/1000)}kb). Please re-run to download.`;
            }
            if (stripped.children) stripped.children = stripLargeBinaries(stripped.children);
            return stripped;
          });
        };
        localStorage.setItem('thermo-ai-files', JSON.stringify(stripLargeBinaries(files)));
      } catch (fallbackErr) {
        console.error("Fallback storage save failed", fallbackErr);
      }
    }
  }, [files]);

  /**
   * Handle recursive file deletion
   */
  const deleteFile = useCallback((id: string, path: string) => {
    if (id === 'root') return;

    const recursiveDelete = (nodes: FileNode[]): FileNode[] => {
      return nodes
        .filter(node => node.id !== id)
        .map(node => ({
          ...node,
          children: node.children ? recursiveDelete(node.children) : undefined
        }));
    };

    setFiles(prev => {
      const updated = recursiveDelete(prev);
      if (selectedFilePath === path || (selectedFilePath && selectedFilePath.startsWith(path + '/'))) {
        setSelectedFilePath(null);
        setPreviewFile(null);
        setEditingFile(null);
      }
      return updated;
    });
  }, [selectedFilePath]);

  /**
   * Handle recursive file content update
   */
  const updateFileContent = useCallback((id: string, newContent: string) => {
    const recursiveUpdate = (nodes: FileNode[]): FileNode[] => {
      return nodes.map(node => {
        if (node.id === id) {
          return { ...node, content: newContent };
        }
        if (node.children) {
          return { ...node, children: recursiveUpdate(node.children) };
        }
        return node;
      });
    };

    setFiles(prev => recursiveUpdate(prev));
  }, []);

  const findFileByPath = (nodes: FileNode[], path: string): FileNode | null => {
    for (const node of nodes) {
      if (node.path === path && node.type === 'file') return node;
      if (node.children) {
        const found = findFileByPath(node.children, path);
        if (found) return found;
      }
    }
    return null;
  };

  const handleFileOpen = (path: string) => {
    const file = findFileByPath(files, path);
    if (file) setPreviewFile(file);
    setSelectedFilePath(path);
  };

  const handleFileEdit = (path: string) => {
    const file = findFileByPath(files, path);
    if (file) setEditingFile(file);
  };

  return (
    <div className="flex h-screen bg-black text-[var(--industrial-text)] overflow-hidden font-sans">
      <aside className="w-16 flex flex-col items-center py-6 border-r border-[var(--industrial-border)] bg-black space-y-8 z-20 shadow-[4px_0_24px_rgba(0,0,0,0.4)]">
        <div className="p-2 bg-[var(--industrial-accent)] rounded-none shadow-lg shadow-[var(--industrial-accent)]/20 mb-4 cursor-pointer hover:scale-105 transition-transform">
          <BrainCircuit className="w-6 h-6 text-white" />
        </div>
        
        <nav className="flex flex-col space-y-6">
          <NavIcon icon={<FileSearch />} label="Literature Agent" active={activeTab === AppTab.LITERATURE} onClick={() => setActiveTab(AppTab.LITERATURE)} />
          <NavIcon icon={<Boxes />} label="Structuring Studio" active={activeTab === AppTab.STRUCTURING} onClick={() => setActiveTab(AppTab.STRUCTURING)} />
          <NavIcon icon={<Settings />} label="Optimization Wizard" active={activeTab === AppTab.WIZARD} onClick={() => setActiveTab(AppTab.WIZARD)} />
          <NavIcon icon={<Zap />} label="Advanced Optimization" active={activeTab === AppTab.ADVANCED_OPT} onClick={() => setActiveTab(AppTab.ADVANCED_OPT)} />
          <NavIcon icon={<Target />} label="Uncertainty Analysis" active={activeTab === AppTab.UNCERTAINTY} onClick={() => setActiveTab(AppTab.UNCERTAINTY)} />
          <NavIcon icon={<Cpu />} label="Compute Monitor" active={activeTab === AppTab.MONITOR} onClick={() => setActiveTab(AppTab.MONITOR)} />
          <NavIcon icon={<BarChart3 />} label="Analysis & UQ" active={activeTab === AppTab.ANALYSIS} onClick={() => setActiveTab(AppTab.ANALYSIS)} />
        </nav>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 bg-black overflow-hidden border-r border-[var(--industrial-border)] relative">
        <header className="h-14 border-b border-[var(--industrial-border)] flex items-center px-6 justify-between bg-black">
          <div className="flex items-center space-x-2 text-sm font-medium">
            <span className="text-slate-500 uppercase tracking-widest text-[10px] font-bold">ThermoAI Studio</span>
            <ChevronRight className="w-4 h-4 text-slate-600" />
            <span className="text-[var(--industrial-accent)] font-bold tracking-tight uppercase">{activeTab.replace('-', ' ')}</span>
          </div>
          <div className="flex items-center space-x-3">
             <div className="industrial-tag">
               <Tag size={10} className="mr-1 inline" />
               <span>VER: {activeTab === AppTab.LITERATURE ? 'AI-MINING' : 'CALPHAD-OPS'}</span>
             </div>
             <div className="px-3 py-1 bg-black rounded-none text-[10px] text-slate-400 border border-[var(--industrial-border)] font-mono">
               Engine: <span className="text-emerald-500">Ready</span>
             </div>
          </div>
        </header>

        <section className="flex-1 overflow-auto relative">
          <div className={activeTab === AppTab.LITERATURE ? 'h-full block' : 'hidden'}>
            <LiteratureAgent setFiles={setFiles} state={literatureState} setState={setLiteratureState} />
          </div>
          <div className={activeTab === AppTab.STRUCTURING ? 'h-full block' : 'hidden'}>
            <StructuringStudio selectedFile={selectedFilePath} setFiles={setFiles} files={files} />
          </div>
          <div className={activeTab === AppTab.WIZARD ? 'h-full block' : 'hidden'}>
            <Wizard config={currentConfig} setConfig={setCurrentConfig} files={files} setFiles={setFiles} />
          </div>
          <div className={activeTab === AppTab.ADVANCED_OPT ? 'h-full block' : 'hidden'}>
            <AdvancedOptimization files={files} setFiles={setFiles} />
          </div>
          <div className={activeTab === AppTab.UNCERTAINTY ? 'h-full block' : 'hidden'}>
            <UncertaintyAnalysis files={files} />
          </div>
          <div className={activeTab === AppTab.MONITOR ? 'h-full block' : 'hidden'}>
            <Monitor jobs={jobs} files={files} setFiles={setFiles} />
          </div>
          <div className={activeTab === AppTab.ANALYSIS ? 'h-full block' : 'hidden'}>
            <Analysis files={files} />
          </div>
        </section>
      </main>

      <RightSidebar 
        files={files} 
        setFiles={setFiles} 
        onFileSelect={handleFileOpen} 
        onFileEdit={handleFileEdit}
        activeFilePath={selectedFilePath} 
        onDeleteFile={deleteFile}
      />

      {previewFile && <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />}
      {editingFile && (
        <FileEditorModal 
          file={editingFile} 
          onSave={updateFileContent} 
          onClose={() => setEditingFile(null)} 
        />
      )}
    </div>
  );
};

const NavIcon: React.FC<{ icon: React.ReactNode, label: string, active: boolean, onClick: () => void }> = ({ icon, label, active, onClick }) => (
  <button 
    onClick={onClick}
    className={`group relative p-3 rounded-none transition-all duration-200 select-none ${active ? 'bg-[var(--industrial-accent)]/10 text-[var(--industrial-accent)]' : 'text-slate-500 hover:text-slate-300 hover:bg-slate-900'}`}
    title={label}
  >
    {React.cloneElement(icon as React.ReactElement<any>, { className: "w-6 h-6" })}
    {active && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-[var(--industrial-accent)] shadow-[0_0_12px_rgba(249,115,22,0.5)]" />}
  </button>
);

export default App;
