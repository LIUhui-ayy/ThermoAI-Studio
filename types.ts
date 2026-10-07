
export enum AppTab {
  LITERATURE = 'literature',
  STRUCTURING = 'structuring',
  WIZARD = 'wizard',
  ADVANCED_OPT = 'advanced-opt',
  UNCERTAINTY = 'uncertainty',
  MONITOR = 'monitor',
  ANALYSIS = 'analysis'
}

export interface FileNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  children?: FileNode[];
  content?: string;
  path: string;
  parentId?: string;
}

export interface JobStatus {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  startTime: string;
  log: string[];
}

export interface LiteratureState {
  file: File | null;
  fileUrl: string | null;
  markdownReport: string | null;
  jsonData: string | null;
  tdbData: string | null;
  numPages: number;
  pageNumber: number;
  pdfScale: number;
}

export interface AICcPenalty {
  phase: string;
  hm: number;
  sm: number;
}

export interface ESPEIConfig {
  system: {
    phase_models: string;
    datasets: string | string[];
    tags: Record<string, any>;
  };
  output: {
    verbosity: number;
    logfile: string;
    output_db: string;
    tracefile: string;
    probfile: string;
  };
  generate_parameters?: {
    enabled: boolean;
    excess_model: string;
    ref_state: string;
    ridge_alpha: number;
    aicc_penalty: AICcPenalty[];
  };
  mcmc: {
    enabled: boolean;
    iterations: number;
    scheduler: string;
    cores: number;
    input_db?: string;
    chains_per_parameter: number;
    data_weights: {
      ZPF: number;
      ACR: number;
      HM: number;
      SM: number;
      CPM: number;
    };
  };
}
