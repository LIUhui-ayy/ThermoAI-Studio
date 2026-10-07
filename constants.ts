
export const ESPEI_CONFIG_SCHEMA = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ESPEI Configuration Schema",
  "type": "object",
  "properties": {
    "system": {
      "type": "object",
      "required": ["phase_models", "datasets"],
      "properties": {
        "phase_models": { "type": "string", "description": "Path to phase models JSON" },
        "datasets": { "type": "string", "description": "Path to datasets directory" }
      }
    },
    "mcmc": {
      "type": "object",
      "required": ["iterations", "chains_per_parameter"],
      "properties": {
        "iterations": { "type": "integer", "minimum": 1 },
        "chains_per_parameter": { 
          "type": "integer", 
          "minimum": 2,
          "description": "Must be an even number",
          "multipleOf": 2
        }
      },
      "if": {
        "properties": { "generate_parameters_enabled": { "const": false } }
      },
      "then": {
        "required": ["input_db"]
      }
    }
  }
};

export const DEFAULT_CONFIG: any = {
  system: {
    phase_models: "",
    datasets: [],
    tags: {}
  },
  output: {
    verbosity: 2,
    logfile: "gen-init.log",
    output_db: "GEN-INIT.tdb",
    tracefile: "trace.npy",
    probfile: "prob.npy"
  },
  generate_parameters: {
    enabled: true,
    excess_model: "linear",
    ref_state: "SGTE91",
    ridge_alpha: 1e-100,
    aicc_penalty: []
  },
  mcmc: {
    enabled: true,
    iterations: 1000,
    scheduler: "dask",
    cores: 4,
    chains_per_parameter: 2,
    data_weights: {
      ZPF: 1.0,
      ACR: 1.0,
      HM: 1.0,
      SM: 1.0,
      CPM: 1.0
    }
  }
};