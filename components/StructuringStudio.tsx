
import React, { useState, useRef, useEffect } from 'react';
import { 
  Layers, 
  FlaskConical, 
  Binary, 
  Table, 
  CheckCircle2, 
  AlertTriangle, 
  Save, 
  Database, 
  Upload, 
  X, 
  Wand2, 
  Clipboard, 
  Trash2, 
  Image as ImageIcon,
  FileCode,
  Loader2,
  Check,
  Zap,
  FileJson,
  AlertCircle,
  Copy,
  Monitor,
  ChevronRight,
  FolderOpen,
  Folder
} from 'lucide-react';
import { GoogleGenAI } from "@google/genai";
import { FileNode } from '../types';

interface StructuringStudioProps {
  selectedFile: string | null;
  files: FileNode[];
  setFiles: React.Dispatch<React.SetStateAction<FileNode[]>>;
}

interface Attachment {
  id: string;
  name: string;
  type: string;
  data: string; // base64
  preview?: string;
}

interface StructuredResult {
  id: string;
  label: string;
  content: string; // Raw JSON content
  type: string;    // Output type (e.g., HM_MIX)
}

const AGENTS = [
  { id: 'Phase Models', icon: <Layers size={18} />, desc: 'Foundation: Sublattice models' },
  { id: 'Liquid', icon: <FlaskConical size={18} />, desc: 'Enthalpy/Entropy of Mixing' },
  { id: 'Solid Solution', icon: <Layers size={18} />, desc: 'FCC/BCC/HCP Solutions' },
  { id: 'Compound', icon: <Binary size={18} />, desc: 'Stoichiometric intermetallics' },
  { id: 'Activity', icon: <Table size={18} />, desc: 'Chemical potential mapping' },
  { id: 'ZPF', icon: <CheckCircle2 size={18} />, desc: 'Phase boundaries (ZPF)' },
];

const MULTI_PROPERTY_PROTOCOL = `
#### 🚀 Core Directive: Multi-Window Output Protocol

**1. Output Separation Rules**
When user input is recognized to contain multiple thermodynamic properties (e.g. both Enthalpy and Entropy), it is **strictly forbidden** to merge them into one JSON file, and **strictly forbidden** to distinguish them only by Markdown line breaks.

**2. Machine-Readable Separator**
To allow the frontend to automatically generate multiple windows, please insert a special separator between different JSON code blocks:\`<<<SPLIT_WINDOW>>>\`.
`;

const PHASE_MODELS_SYSTEM_INSTRUCTION = `【Role】
You are an efficient thermodynamic phase model parsing engine, dedicated to transforming handwritten descriptions into JSON structures conforming to the ESPEI specification.

【Input Parsing Rules】
- Component extraction: Recognize content after 'Components:' (e.g. al, mg, va), convert to uppercase array.
- Parsing logic:
    - Solution phase: liquid(al, mg) -> sublattice_model: [["AL", "MG"]], ratios: [1].
    - Compound: beta: al140mg89 -> sublattice_model: [["AL"], ["MG"]], ratios: [140, 89].
    - Complex phase: gamma: mg5(al, mg)12 -> sublattice_model: [["MG"], ["AL", "MG"]], ratios: [5, 12].

【Final JSON Output Format】
Must strictly follow the order below to generate Keys:
1. components: (Array of strings, uppercase)
2. refdata: "SGTE91" (String, top-level only)
3. phases: (Object containing all phase definitions)

Note: Top-level refdata appears only once, phases internally must not contain refdata.

Output example (strictly following order and no Markdown text):
\`\`\`json
{
  "components": ["AL", "MG", "VA"],
  "refdata": "SGTE91",
  "phases": {
    "FCC_A1": {
      "sublattice_model": [["AL", "MG"], ["VA"]],
      "sublattice_site_ratios": [1, 1]
    }
  }
}
\`\`\``;

const LIQUID_AGENT_SYSTEM_INSTRUCTION = `# System Prompt: Liquid Phase Data Agent (Strict Mode)

**Role**
You are a **Liquid Phase Thermodynamic Data Structuring Expert**.
Your task is to transform unstructured data of the liquid phase (LIQUID) into JSON format strictly conforming to the **ESPEI/PyCalphad standard**.

---

### 🛑 Absolute Core Directives

**1. Strict Field Order 1-9**
The generated JSON **MUST AND ONLY** order fields according to the sequence **1 to 9** defined below.
*   **Strictly forbidden to reverse order (e.g. cannot put conditions before solver).
*   **Strictly forbidden** to omit fields.
*   **Strictly forbidden** to add custom fields.

**2. Strict Array Alignment**
*   **Rule: The length of the sublattice_configurations array under the solver field must be exactly equal to the length of sublattice_occupancies (i.e. number of data points).
*   **Action**: If you have $N$ data points, you must generate $N$ configuration items.
    *   ❌ **Error**: There are 5 data points, but only 1 configuration item is written.
    *   ✅ **Correct**: There are 5 data points, configuration item is repeated 5 times.
    *   **Formula: len(sublattice_configurations) == len(sublattice_occupancies) == N.

**3. Multi-Property Splitting**
*   If input contains both H and S, it must be split into two independent JSON code blocks, separated by <<<SPLIT_WINDOW>>>.

---

### Data Structure & Mapping

Please strictly output one by one in the following **1-9** sequence:

**1. \`components\`**: \`List[str]\`
*   System component list, must include VA, all uppercase.
*   Example: [\"AL\", \"SI\", \"VA\"]\`

**2. \`phases\`**: \`List[str]\`
*   Fixed to [\"LIQUID\"].\`.

**3. \`solver\`**: \`Dict\`
*   \`mode\`: \`"manual"\`
*   \`sublattice_site_ratios\`: \`[1]\`
*   **\`sublattice_occupancies\`**: **3D array** \`[[[xA, xB...]], ...]\`
    *   Contains $N$ data points.
*   **\`sublattice_configurations\`**: **3D array** \`[[["A", "B"...]], ...]\`
    *   **Key**: Must contain $N$ elements here! Even if content is identical, repeat $N$ times to achieve alignment.

**4. \`conditions\`**: \`Dict\`
*   \`P\`: \`101325\`
*   \`T\`: Temperature value (K).

**5. \`output\`**: \`str\`
*   \`HM_MIX\`, \`SM_MIX\`, \`ACP\` etc.

**6. \`values\`**: **3D array**
*   \`[[[Val1, Val2...]]]\`
*   All numerical values are flattened in the innermost layer, amount is $N$.

**7. \`reference\`**: \`str\`
*   First author + year (Key).

**8. \`bibtex\`**: \`str\`
*   Complete citation string.

**9. \`comment\`**: \`str\`
*   \`"Experimental"\`, \`"DFT"\`, \`"EST"\`.

---

### Self-Check Protocol

Before outputting, perform the following checks:
1.  **Check order: is components the 1st? is phases the 2nd? ... is comment the 9th? -> Must be.
2.  **Check alignment: how many rows does occupancies have? how many rows does configurations have? -> Must be equal.
3. **Check output**: If there are H and S, are they split into two code blocks? -> Must be split.`;

const SOLID_SOLUTION_AGENT_SYSTEM_INSTRUCTION = `# System Prompt: Solid Solution Data Agent (Strict Mode V4.0)

**Role**
You are a **Solid Solution Phase Thermodynamic Data Structuring Expert**.
Your task is to transform unstructured data of solid solution phases (e.g. FCC, BCC, HCP, GAMMA etc.) into JSON format strictly conforming to the **ESPEI/PyCalphad standard**.

---

### 🛑 Absolute Core Rules

**1. Strict 1-to-1 Alignment for Array Quantities**
This is the most critical rule.
*   **Rule: The length of the sublattice_configurations array under the solver field must be exactly equal to the length of sublattice_occupancies (i.e. number of data points).
*   **Action**: Even if the component configuration of each data point is exactly the same, you must **repeatedly generate** that configuration $N$ times.
    *   ❌ **Error**: There are 3 data points, but only 1 configuration item is written.
    *   ✅ **Correct**: There are 3 data points, and the configuration item list contains 3 elements (repeated 3 times).
    *   **Formula**: \`len(configurations) == len(occupancies) == N\`.

**2. Scalar Rule for Stoichiometric Sublattices**
*   **Rule: For a sublattice completely occupied by a single component (usually vacancy VA):
    *   **Occupancy: Must write as scalar 1, strictly forbidden to write as list [1].
    *   **Configuration: Must write as string VA, strictly forbidden to write as list [\"VA\"].

**3. Strict Field Order 1-9**
*   The generated JSON **MUST AND ONLY** order fields according to the sequence **1 to 9** defined below. Cannot be reversed, missing, or add custom fields.

**4. Multi-property Split**
*   When encountering multiple properties (H, S, Activity), use <<<SPLIT_WINDOW>>> to separate outputs.

---

### Data Structure & Mapping

Please strictly output one by one in the following **1-9** sequence:

**1. \`components\`**: \`List[str]\`
*   System component list, all uppercase, must include \`"VA"\`.
*   Example: \`["AL", "MG", "VA"]\`

**2. \`phases\`**: \`List[str]\`
*   Phase name.

**3. \`solver\`**: \`Dict\`
*   \`mode\`: \`"manual"\`
*   \`sublattice_site_ratios\`: Corresponding sublattice ratio.
*   **\`sublattice_occupancies\`**: **3D array**
    *   Format: ...
    *   Contains $N$ data points.
*   **\`sublattice_configurations\`**: **3D array**
    *   Format: ...
    *   **Note**: The list length here must be $N$! Must correspond one-to-one with occupancies.

**4. \`conditions\`**: \`Dict\`
*   \`P\`: \`101325\`.
*   \`T\`: Temperature value (K).

**5. \`output\`**: \`str\`
*   \`HM_MIX\`, \`SM_MIX\`, \`ACP\`, \`HM_FORM\`, \`SM_FORM\`.

**6. \`values\`**: **3D array**
*   \`[[[Val1, Val2...]]]\`
*   All numerical values are flattened in the innermost layer, amount is $N$.

**7. \`reference\`**: \`str\`
*   Format: \`"AuthorYear"\` (Key).

**8. \`bibtex\`**: \`str\`
*   Complete citation string.

**9. \`comment\`**: \`str\`
*   \`"Experimental"\`, \`"DFT"\`, \`"EST"\`.

---

### Self-Check Protocol

Before output, self-check:
1.  **Alignment check: How many rows does occupancies have? How many rows does configurations have? -> Must be equal.
2.  **Scalar check: Are all vacancy occupancies 1? -> Must be.
3.  **Structure check: Is values a 3D structure? -> Must be.`;

const COMPOUND_AGENT_SYSTEM_INSTRUCTION = `# System Prompt: Compound Phase Data Agent (Fix V3.1)

**Role**
You are a **Thermodynamic Data Structuring Expert for Stoichiometric Compounds**.
Your task is to transform unstructured data of stoichiometric compounds into JSON format strictly conforming to the ESPEI/PyCalphad standard.

---

### 🛑 Absolute Core Rules

**1. Configuration Formatting Fix**
*   **Rule**: \`sublattice_configurations\` is a 2D array \`List[List[str]]\`.
*   **Key**: The inner list represents **the occupancy of all sublattices in one configuration**.
    *   If the compound model is Subl1: A, Subl2: B.
    *   ❌ **Error format (this will be parsed as two different configurations).
    *   ✅ **Correct format (this means in the same configuration, sublattice 1 is A, sublattice 2 is B).

**2. Structural Specifics**
*   **Strictly forbidden to include Occupancies: Stoichiometric compounds must not include the sublattice_occupancies field.

**3. Multi-property Split**
*   When encountering multiple properties, must use <<<SPLIT_WINDOW>>> to separate outputs, merging is forbidden.

**4. Field Order 1-9**
*   Must strictly follow the order defined below.

**5. Phase Type Smart Check**
*   If there is a **composition change** in the data table (e.g. $x_{Mg}$ changes from 0.1 to 0.2), this indicates it's not a stoichiometric compound. Please stop processing and prompt: 'Composition change detected, please use Solid Solution Agent.'

---

### Data Structure & Mapping

Please strictly output one by one in the following **1-9** sequence:

**1. \`components\`**: \`List[str]\`
*   System component list, all uppercase, must include \`"VA"\`.
*   Example: \`["AL", "MG", "VA"]\`

**2. \`phases\`**: \`List[str]\`
*   Phase name.

**3. \`solver\`**: \`Dict\`
*   \`mode\`: Fixed to manual.
*   \`sublattice_site_ratios\`: Get from phase model.
*   **\`sublattice_configurations\`**: \`List[List[str]]\`
    *   **Format**: \`[["<Subl1_Species>", "<Subl2_Species>", ...]]\`
    *   *Example: For Beta phase (Al-Mg), output [[\"AL\", \"MG\"]].

**4. \`conditions\`**: \`Dict\`
*   \`P\`: \`101325\`.
*   \`T\`: Temperature list [300, 400] or scalar.

**5. \`output\`**: \`str\`
*   \`HM_FORM\`, \`SM_FORM\`, \`CPM\`, \`GM\`.

**6. \`values\`**: **3D array**
*   \`[[[Val1, Val2...]]]\`
*   All values are flattened in the innermost layer.

**7. \`reference\`**: \`str\`
*   Format: \`"AuthorYear"\` (Key).

**8. \`bibtex\`**: \`str\`
*   Complete citation string.

**9. \`comment\`**: \`str\`
*   \`"Experimental"\`, \`"DFT"\`, \`"EST"\`.

---

### Self-Check Protocol

1.  **Configuration Check**:
    *   Are there two sublattices? -> Yes.
    *   Is output [[\"AL\", \"MG\"]]? -> Must be.
    *   If [[\"AL\"], [\"MG\"]] -> Error, merge inner lists immediately.
2.  **Occupancy Check**: Is this field removed? -> **Must be removed**.`;

const ACTIVITY_AGENT_SYSTEM_INSTRUCTION = `# System Prompt: Activity Data Agent (Strict Mode V3.1 Final)

**Role**
You are a **Thermodynamic Activity Data Structuring Expert**.
Your task is to transform unstructured data related to Activity into JSON format strictly conforming to the **ESPEI/PyCalphad standard**.

---

### 🛑 Absolute Core Rules

**1. Variable Synchronization Protocol**
*   **Rule: The component variable key name in reference_state must be exactly the same as the component variable key name in the main conditions.
*   **Reverse/Complementary Logic**:
    *   If Output is ACR_AL (Al activity), and independent variable in data table is X_MG (Mg composition).
    *   Then write X_MG: [...] in conditions.
    *   **Key: You must also write X_MG: ... in reference_state.
    *   *Numerical calculation: If reference state is pure Al, and variable is X_MG, then reference state value is 0.0.

**2. Structural Specifics**
*   **No Solver: Strictly forbidden to include solver field.
*   **Required Reference State**: Must include reference state definition.

**3. Multi-property Split**
*   If input contains activities of multiple components simultaneously, must use <<<SPLIT_WINDOW>>> to separate output.

**4. Field Order 1-9**
*   Must be strictly observed.

---

### Data Structure & Mapping

Please strictly output one by one in the following **1-9** sequence:

**1. \`components\`**: \`List[str]\`
*   System component list, all uppercase, must include \`"VA"\`.

**2. \`phases\`**: \`List[str]\`
*   Phase name.

**3. \`reference_state\`**: \`Dict\` (**Core field
*   \`phases\`: Keep consistent with main phases.
*   \`conditions\`:
    *   \`P\`: \`101325\`
    *   \`T\`: Scalar temperature.
    *   **\`X_<VAR>\`**: **Key variable.
        *   Variable name must be consistent with variable name in step 4.
        *   Value: Fill 1.0 or 0.0 according to reference state definition.
        *   *Example: Output=ACR_AL (reference state pure Al), Variable=X_MG. Then fill X_MG: 0.0 here.

**4. \`conditions\`**: \`Dict\`
*   \`P\`: \`101325\`.
*   \`T\`: Scalar temperature (e.g. 1100).
*   **\`X_<VAR>\`**: **1D array [x1, x2...].
    *   This is the independent variable (x-axis) in the data.

**5. \`output\`**: \`str\`
*   Format: ...

**6. \`values\`**: **3D array**
*   \`[[[Val1, Val2...]]]\` (consistent with conditions length.

**7. \`reference\`**: \`str\`
*   Format: \`"AuthorYear"\` (Key).

**8. \`bibtex\`**: \`str\`
*   Complete citation string.

**9. \`comment\`**: \`str\`
*   \`"Experimental"\`, \`"DFT"\`, \`"EST"\`.

---

### Self-Check Protocol

1.  **Variable consistency: is the X_ variable name the same in reference_state and conditions? -> Must be exactly the same.
2. **Numerical Logic**: Does the reference state value (\`0.0\` or \`1.0\`) correctly correspond to the physical meaning? -> **Must be correct**.
3. **Solver**: Is \`solver\` removed? -> **Must be removed**.`;

const ZPF_AGENT_SYSTEM_INSTRUCTION = `# System Prompt: ZPF Phase Equilibrium Data Agent (Strict Mode V3.0)

**Role**
You are a **Phase Diagram and Phase Equilibrium Data Structuring Expert**.
Your task is to transform phase equilibrium data (ZPF, Zero Phase Fraction) into JSON format strictly conforming to the **ESPEI standard**.

---

### 🛑 Absolute Core Rules

**1. ZPF Specifics**
*   **Two-phase description**: The core of ZPF data is to describe the coexistence of two phases under specific conditions.
*   **Values structure**: \`values\` is a list, each element represents a data point. Each data point contains two sublists, respectively describing the two equilibrium phases.
    *   *Format*: \`[ ["PHASE_1", ["COMP"], [x]], ["PHASE_2", ["COMP"], [null]] ]\`
    *   *Null Rule*: For the phase with 'zero phase fraction' (i.e. the other side of the phase boundary), the composition is usually filled with \`null\`, indicating this phase exists under this condition, but the composition is undetermined or unimportant (as a boundary condition).

**2. Strict Field Order 1-9**
*   The generated JSON **MUST AND ONLY** order fields according to the sequence **1 to 9** defined below.

**3. Temperature Handling**
*   If data points correspond to different temperatures, \`conditions.T\` is a list, and \`broadcast_conditions\` is set to \`false\`.

---

### Data Structure & Mapping

Please strictly output one by one in the following **1-9** sequence:

**1. \`components\`**: \`List[str]\`
*   System component list, all uppercase, must include \`"VA"\`.

**2. \`phases\`**: \`List[str]\`
*   All phase names involved.

**3. \`conditions\`**: \`Dict\`
*   \`P\`: \`101325\`.
*   \`T\`: Temperature list \`[T1, T2...]\` (usually) or scalar \`T\`.

**4. \`broadcast_conditions\`**: \`bool\`
*   \`false\`: If T is a list and length equals the number of data points (recommended).
*   \`true\`: If T is a scalar, all points share one temperature.

**5. \`output\`**: \`str\`
*   Fixed as \`"ZPF"\`.

**6. \`values\`**: **3D nested array**
*   **Structure**: \`[ Point1, Point2, ... ]\`
*   **Point Structure**: \`[ Phase1_Info, Phase2_Info ]\`
*   **Phase Info Structure**: \`[ "PHASE_NAME", ["COMP_NAME"], [Value or null] ]\`
*   *Example*: \`[["LIQUID", ["SI"], [0.35]], ["FCC_A1", ["SI"], [null]]]\`

**7. \`reference\`**: \`str\`
*   Format: \`"AuthorYear"\` (Key).

**8. \`bibtex\`**: \`str\`
*   Complete citation string.

**9. \`comment\`**: \`str\`
*   Explain data nature, e.g. \`"Liquid/FCC boundary"\`.

---

### Input/Output Example (Standard ZPF Demo)

**User Input:**
> System: Al-Si.
> Data table:
> | T (C) | x_Si (Liquid) | Equilibrium Phase |
> |-------|---------------|-------------------|
> | 600   | 0.15          | FCC_A1            |
> | 580   | 0.12          | FCC_A1            |

**Agent Output:**

\`\`\`json
{
  "components": ["AL", "SI", "VA"],
  "phases": ["LIQUID", "FCC_A1"],
  "conditions": {
    "P": 101325,
    "T": [873.15, 853.15]
  },
  "broadcast_conditions": false,
  "output": "ZPF",
  "values": [
    [
      ["LIQUID", ["SI"], [0.15]],
      ["FCC_A1", ["SI"], [null]]
    ],
    [
      ["LIQUID", ["SI"], [0.12]],
      ["FCC_A1", ["SI"], [null]]
    ]
  ],
  "reference": "Unknown2024",
  "bibtex": "Unknown Source",
  "comment": "Liquid/FCC_A1 phase boundary"
}
\`\`\`

---

### Processing Logic

1.  **Temperature Conversion**: Convert °C to K.
2.  **Phase Identification**: Identify which column is the phase with known composition (e.g. Liquid), and which is the equilibrium phase (e.g. FCC).
    *   Known phase filled with \`[composition]\`.
    *   Equilibrium phase filled with \`[null]\`.
3.  **Build Values**: Loop through each row of data, generate nested list.
4.  **Validation**: Does the length of \`values\` equal the length of \`conditions.T\`? (When broadcast=false) -> **Must be equal**.`;

const DEFAULT_SYSTEM_INSTRUCTION = `You are an expert CALPHAD/ESPEI data structuring agent.`;

const StructuringStudio: React.FC<StructuringStudioProps> = ({ selectedFile, setFiles, files }) => {
  const [activeAgentId, setActiveAgentId] = useState('Phase Models');
  const [inputText, setInputText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [results, setResults] = useState<StructuredResult[]>([]);
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [hasFoundation, setHasFoundation] = useState(false);
  
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [targetFolderPath, setTargetFolderPath] = useState('/espei_datasets');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [jsonError, setJsonError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync targetFolderPath with selected Resource Hub active folder
  useEffect(() => {
    if (selectedFile) {
      const findNode = (nodes: FileNode[], path: string): FileNode | null => {
        for (const node of nodes) {
          if (node.path === path) return node;
          if (node.children) {
            const found = findNode(node.children, path);
            if (found) return found;
          }
        }
        return null;
      };
      const node = findNode(files, selectedFile);
      if (node && node.type === 'folder') {
        setTargetFolderPath(node.path);
      }
    }
  }, [selectedFile, files]);

  // Derive all available folders for the selection dropdown
  const getAllFolders = (nodes: FileNode[], prefix = ''): { name: string, path: string }[] => {
    let folders: { name: string, path: string }[] = [];
    for (const node of nodes) {
      if (node.type === 'folder') {
        folders.push({ name: node.name, path: node.path });
        if (node.children) {
          folders = [...folders, ...getAllFolders(node.children, node.path)];
        }
      }
    }
    return folders;
  };
  const availableFolders = getAllFolders(files);

  // Clear function to reset inputs and outputs
  const clearAll = () => {
    setInputText('');
    setAttachments([]);
    setResults([]);
    setActiveResultIndex(0);
    setJsonError(null);
  };

  // Handle Agent Switching
  const handleAgentSwitch = (id: string) => {
    setActiveAgentId(id);
    setResults([]);
    setActiveResultIndex(0);
    setJsonError(null);
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.indexOf('image') !== -1) {
        const file = item.getAsFile();
        if (file) addAttachment(file);
      }
    }
  };

  const addAttachment = async (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      const preview = URL.createObjectURL(file);
      setAttachments(prev => [...prev, {
        id: Math.random().toString(36).substr(2, 9),
        name: file.name,
        type: file.type,
        data: base64,
        preview: file.type.startsWith('image/') ? preview : undefined
      }]);
    };
    reader.readAsDataURL(file);
  };

  const startStructuring = async () => {
    if (!inputText && attachments.length === 0) return;
    
    setIsProcessing(true);
    setJsonError(null);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      let systemInstruction = DEFAULT_SYSTEM_INSTRUCTION;
      if (activeAgentId === 'Phase Models') systemInstruction = PHASE_MODELS_SYSTEM_INSTRUCTION;
      else if (activeAgentId === 'Liquid') systemInstruction = LIQUID_AGENT_SYSTEM_INSTRUCTION;
      else if (activeAgentId === 'Solid Solution') systemInstruction = SOLID_SOLUTION_AGENT_SYSTEM_INSTRUCTION;
      else if (activeAgentId === 'Compound') systemInstruction = COMPOUND_AGENT_SYSTEM_INSTRUCTION;
      else if (activeAgentId === 'Activity') systemInstruction = ACTIVITY_AGENT_SYSTEM_INSTRUCTION;
      else if (activeAgentId === 'ZPF') systemInstruction = ZPF_AGENT_SYSTEM_INSTRUCTION;

      const promptParts: any[] = [{ text: `Agent: ${activeAgentId}\nInput Data:\n${inputText}\n\nPlease perform deep structural analysis according to the following protocol:\n${MULTI_PROPERTY_PROTOCOL}` }];
      
      attachments.forEach(att => {
        if (att.type.startsWith('image/')) {
          promptParts.push({ inlineData: { data: att.data, mimeType: att.type } });
        } else {
          promptParts.push({ text: `Attached Content (${att.name}): ${att.data}` });
        }
      });

      const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: promptParts,
        config: { systemInstruction, temperature: 0.1 }
      });

      const text = response.text || "";
      const rawParts = text.split('<<<SPLIT_WINDOW>>>');
      const newResults: StructuredResult[] = [];
      
      rawParts.forEach((part, index) => {
        const jsonMatch = part.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          const content = jsonMatch[1].trim();
          let label = `Result ${index + 1}`;
          try {
            const parsed = JSON.parse(content);
            label = parsed.output || label;
          } catch {}
          newResults.push({ id: Math.random().toString(36).substr(2, 9), label, content, type: label });
        } else if (part.trim()) {
           newResults.push({ id: Math.random().toString(36).substr(2, 9), label: 'Analysis', content: part.trim(), type: 'TEXT' });
        }
      });

      if (newResults.length > 0) {
        setResults(newResults);
        setActiveResultIndex(0);
        if (activeAgentId === 'Phase Models') setHasFoundation(true);
      } else {
        setResults([{ id: 'err', label: 'Response', content: text, type: 'TEXT' }]);
      }
    } catch (err: any) {
      setResults([{ id: 'err', label: 'Error', content: err.message, type: 'ERROR' }]);
    } finally {
      setIsProcessing(false);
    }
  };

  /**
   * INITIATE SAVE TRIGGER: 
   * For Phase Models: Implements dynamic naming and opens commit modal (no longer silent).
   * For others: Generates filename and opens commit modal.
   */
  const initiateSave = async () => {
    const res = results[activeResultIndex];
    if (!res) return;
    
    try {
      if (res.type === 'TEXT') {
        setNewFileName(`analysis_${Date.now()}.txt`);
        setIsSaveModalOpen(true);
        return;
      }

      const json = JSON.parse(res.content);

      // Phase Model Specific logic: Dynamic naming
      if (activeAgentId === 'Phase Models') {
        const components = (json.components || []) as string[];
        const compsStr = components
          .filter(c => c !== 'VA')
          .map(c => c.toLowerCase())
          .sort()
          .join('-');
        const fileName = `${compsStr}-phase_models.json`;
        
        setNewFileName(fileName);
        setIsSaveModalOpen(true);
        return;
      }

      // Generic logic for other agents
      let authorSlug = 'Unknown';
      let yearSlug = '202X';
      const ref = json.reference || '';
      if (ref) {
        const authorMatch = ref.match(/^[a-zA-Z]+/);
        if (authorMatch) authorSlug = authorMatch[0];
        const yearMatch = ref.match(/\d{4}/);
        if (yearMatch) yearSlug = yearMatch[0];
      }

      const agentMap: Record<string, string> = {
        'Liquid': 'Liquid',
        'Solid Solution': 'SolidSolution',
        'Compound': 'Compound',
        'Activity': 'Activity',
        'ZPF': 'ZPF'
      };
      const agentSlug = agentMap[activeAgentId] || 'Agent';

      let phaseSlug = 'UnknownPhase';
      if (json.phases && Array.isArray(json.phases) && json.phases.length > 0) {
        phaseSlug = json.phases[0].replace(/\s+/g, '_');
      }

      let typeSlug = 'DATA';
      const output = (json.output || '').toUpperCase();
      if (output.includes('HM_MIX')) typeSlug = 'HM_MIX';
      else if (output.includes('SM_MIX')) typeSlug = 'SM_MIX';
      else if (output.includes('HM_FORM')) typeSlug = 'HM_FORM';
      else if (output.includes('SM_FORM')) typeSlug = 'SM_FORM';
      else if (output.startsWith('ACR') || output === 'AC') typeSlug = 'AC';
      else if (output === 'ZPF') typeSlug = 'ZPF';
      else if (output) typeSlug = output;

      const fileName = `${agentSlug}-${phaseSlug}-${typeSlug}-${authorSlug}-${yearSlug}.json`;
      setNewFileName(fileName);
      setIsSaveModalOpen(true);
    } catch (e: any) {
      setJsonError(`Filename Generation Failed: Valid JSON is required. ${e.message}`);
      setNewFileName(`output_${Date.now()}.json`);
      setIsSaveModalOpen(true);
    }
  };

  const performSilentSave = async (fileName: string, content: string) => {
    setSaveStatus('saving');
    const newFile: FileNode = {
      id: Math.random().toString(36).substr(2, 9),
      name: fileName,
      type: 'file',
      path: `${targetFolderPath === '/' ? '' : targetFolderPath}/${fileName}`,
      content: content
    };

    await new Promise(r => setTimeout(r, 600));

    setFiles(prev => {
      const newFiles = JSON.parse(JSON.stringify(prev)) as FileNode[];
      const findAndAdd = (nodes: FileNode[]): boolean => {
        for (let node of nodes) {
          if (node.path === targetFolderPath && node.type === 'folder') {
            node.children = [...(node.children || []), newFile];
            return true;
          }
          if (node.children && findAndAdd(node.children)) return true;
        }
        return false;
      };

      if (!findAndAdd(newFiles)) {
        const root = newFiles[0];
        root.children = [...(root.children || []), newFile];
      }
      return newFiles;
    });

    setSaveStatus('saved');
    setTimeout(() => { setSaveStatus('idle'); }, 2000);
  };

  const confirmSave = async () => {
    const res = results[activeResultIndex];
    if (!res) return;
    const finalFileName = newFileName.endsWith('.json') || newFileName.endsWith('.txt') ? newFileName : `${newFileName}.json`;
    await performSilentSave(finalFileName, res.content);
    setIsSaveModalOpen(false);
  };

  return (
    <div className="h-full flex flex-col bg-black font-sans text-[var(--industrial-text)] overflow-hidden relative">
      
      {/* 1. TOP LAYER: AGENT NAVIGATION BAR */}
      <div className="h-20 shrink-0 bg-black border-b border-[var(--industrial-border)] flex items-center px-6 space-x-3 overflow-x-auto scrollbar-hide z-30">
        {AGENTS.map(agent => (
          <button
            key={agent.id}
            onClick={() => handleAgentSwitch(agent.id)}
            className={`flex-shrink-0 flex items-center space-x-3 px-5 py-2.5 rounded-none border transition-all duration-300 ${
              activeAgentId === agent.id 
                ? 'bg-[var(--industrial-accent)] border-[var(--industrial-accent)] text-white shadow-[0_0_25px_rgba(249,115,22,0.3)] scale-[1.03]' 
                : 'bg-black border-[var(--industrial-border)] text-slate-500 hover:text-slate-300 hover:bg-white/5'
            }`}
          >
            <div className={activeAgentId === agent.id ? 'text-white' : 'text-[var(--industrial-accent)]/70'}>{agent.icon}</div>
            <div className="text-left">
              <div className="text-[9px] font-bold uppercase tracking-widest opacity-60 leading-none mb-1">Agent</div>
              <div className="text-xs font-bold whitespace-nowrap">{agent.id}</div>
            </div>
          </button>
        ))}
        <div className="flex-1" />
        {hasFoundation ? (
          <div className="flex items-center space-x-2 bg-emerald-500/10 border border-emerald-500/30 px-4 py-2 rounded-none text-emerald-400 text-[10px] font-bold uppercase tracking-widest">
            <Check size={14} />
            <span>Workspace Ready</span>
          </div>
        ) : (
          <div className="flex items-center space-x-2 bg-amber-500/10 border border-amber-500/30 px-4 py-2 rounded-none text-amber-400 text-[10px] font-bold uppercase tracking-widest">
            <AlertTriangle size={14} />
            <span>No Foundation</span>
          </div>
        )}
      </div>

      {/* SPLIT MAIN CONTENT */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* 2. MIDDLE LAYER: UNIVERSAL INPUT ZONE (LEFT) */}
        <div className="w-1/2 flex flex-col border-r border-[var(--industrial-border)] bg-black">
          <div className="h-10 border-b border-[var(--industrial-border)] flex items-center px-4 justify-between bg-black">
            <div className="flex items-center space-x-2">
              <Clipboard size={14} className="text-slate-500" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Universal Input Zone</span>
            </div>
            <div className="flex items-center space-x-4">
              <button onClick={() => fileInputRef.current?.click()} className="text-slate-500 hover:text-[var(--industrial-accent)] transition-colors" title="Upload Attachment">
                <Upload size={14} />
              </button>
              <button onClick={clearAll} className="text-slate-500 hover:text-red-400 transition-colors" title="Clear All Workspace">
                <Trash2 size={14} />
              </button>
            </div>
          </div>

          <div className="flex-1 flex flex-col p-6 space-y-4 overflow-hidden">
            <div className="flex-1 bg-black border border-[var(--industrial-border)] rounded-none p-1 flex flex-col overflow-hidden focus-within:border-[var(--industrial-accent)]/50 transition-all">
              <textarea
                className="flex-1 bg-transparent p-7 text-sm text-slate-300 placeholder:text-slate-700 outline-none resize-none font-sans leading-relaxed custom-scrollbar"
                placeholder={
                  activeAgentId === 'Phase Models' ? 'e.g., Components: al, mg, va\nfcc_a1(al, mg)1va1\nbeta: al140mg89' :
                  activeAgentId === 'Activity' ? 'e.g., Mg-Al, Liquid, 1100K. Ref: Pure Mg. x_Al=0.8, a_Mg=0.07' :
                  `[${activeAgentId} Agent Active] Paste thermodynamic snippets, literature tables, or raw experiment notes here...`
                }
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onPaste={handlePaste}
              />
            </div>

            {attachments.length > 0 && (
              <div className="h-28 flex space-x-3 overflow-x-auto scrollbar-hide py-2 shrink-0">
                {attachments.map(att => (
                  <div key={att.id} className="relative group shrink-0 w-24 h-full bg-black rounded-none overflow-hidden border border-[var(--industrial-border)] shadow-xl">
                    {att.preview ? (
                      <img src={att.preview} className="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-all" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-slate-700">
                        <FileCode size={20} />
                      </div>
                    )}
                      <button 
                      onClick={() => setAttachments(prev => prev.filter(a => a.id !== att.id))} 
                      className="absolute top-1 right-1 p-1 bg-black rounded-none text-slate-400 opacity-0 group-hover:opacity-100 transition-all hover:text-red-400"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={startStructuring}
              disabled={isProcessing || (!inputText && attachments.length === 0)}
              className="h-14 bg-[var(--industrial-accent)] hover:bg-[var(--industrial-accent-muted)] disabled:bg-slate-900 disabled:text-slate-500 text-white rounded-none font-bold flex items-center justify-center space-x-3 shadow-xl shadow-orange-900/20 transition-all active:scale-[0.98] shrink-0"
            >
              {isProcessing ? <Loader2 size={20} className="animate-spin" /> : <Wand2 size={20} />}
              <span className="tracking-tight uppercase text-xs tracking-widest">{isProcessing ? 'Agent Thinking...' : `Start ${activeAgentId} Conversion`}</span>
            </button>
          </div>
        </div>

        {/* 3. BOTTOM/RIGHT LAYER: DYNAMIC MULTI-TAB OUTPUT ZONE */}
        <div className="w-1/2 flex flex-col bg-black overflow-hidden">
          
          <div className="h-10 border-b border-[var(--industrial-border)] flex items-center bg-black px-2 overflow-x-auto scrollbar-hide shrink-0">
            {results.length === 0 ? (
              <div className="px-4 text-[10px] font-bold text-slate-600 uppercase tracking-widest flex items-center space-x-2">
                <Monitor size={14} />
                <span>Ready for Structuring Output</span>
              </div>
            ) : (
              results.map((res, idx) => (
                <button
                  key={res.id}
                  onClick={() => setActiveResultIndex(idx)}
                  className={`h-full px-6 flex items-center space-x-2 text-[10px] font-bold uppercase tracking-tight transition-all border-b-2 whitespace-nowrap ${
                    activeResultIndex === idx 
                    ? 'border-[var(--industrial-accent)] text-[var(--industrial-accent)] bg-[var(--industrial-accent)]/10' 
                    : 'border-transparent text-slate-500 hover:text-slate-300 hover:bg-white/5'
                  }`}
                >
                  <FileCode size={12} />
                  <span>{res.label}</span>
                </button>
              ))
            )}
          </div>

          <div className="h-12 border-b border-[var(--industrial-border)] flex items-center px-6 justify-between bg-black shrink-0">
            <div className="flex items-center space-x-3">
               <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--industrial-accent)]/70">
                 {results[activeResultIndex]?.type || 'Waiting...'}
               </span>
            </div>
            {results.length > 0 && (
              <div className="flex items-center space-x-2">
                <button 
                  onClick={() => { navigator.clipboard.writeText(results[activeResultIndex].content); }}
                  className="p-2 hover:bg-[var(--industrial-surface)] rounded-none text-slate-400 hover:text-white transition-colors"
                  title="Copy to Clipboard"
                >
                  <Copy size={16} />
                </button>
                <button 
                  onClick={initiateSave}
                  className="flex items-center space-x-2 px-4 py-1.5 bg-[var(--industrial-accent)] hover:bg-[var(--industrial-accent-muted)] text-white rounded-none text-[10px] font-bold shadow-lg transition-all"
                >
                  {saveStatus === 'saving' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  <span>{saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : 'Commit File'}</span>
                </button>
              </div>
            )}
          </div>

          {jsonError && (
            <div className="m-4 bg-red-900/20 border border-red-900/50 p-4 rounded-none flex items-center space-x-3 text-red-500 animate-in slide-in-from-top-2">
              <AlertCircle size={16} className="shrink-0" />
              <span className="text-[10px] font-bold uppercase tracking-widest leading-relaxed flex-1">{jsonError}</span>
              <button onClick={() => setJsonError(null)} className="p-1 hover:text-white"><X size={14} /></button>
            </div>
          )}

          <div className="flex-1 p-8 font-mono text-sm overflow-hidden flex relative">
            <textarea
              className="w-full h-full bg-transparent text-[var(--industrial-accent)]/90 outline-none resize-none leading-relaxed custom-scrollbar placeholder:text-slate-800 selection:bg-[var(--industrial-accent)]/20"
              spellCheck={false}
              value={results[activeResultIndex]?.content || "// Structure output will appear here..."}
              onChange={(e) => {
                const newResults = [...results];
                if (newResults[activeResultIndex]) {
                  newResults[activeResultIndex].content = e.target.value;
                  setResults(newResults);
                }
              }}
            />
            {results.length === 0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none opacity-[0.03]">
                <Database size={240} className="text-[var(--industrial-accent)]" />
              </div>
            )}
          </div>
          
          <div className="h-10 border-t border-[var(--industrial-border)] bg-black flex items-center px-6 justify-between text-[10px] text-slate-600 font-bold uppercase tracking-tighter shrink-0">
             <span>Protocol: Multi-Window V3.0 (Strict)</span>
             <span>Factory Mode: {activeAgentId}</span>
          </div>
        </div>
      </div>

      {/* SAVE TO WORKSPACE MODAL */}
      {isSaveModalOpen && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-6 bg-black backdrop-blur-md animate-in fade-in duration-300">
          <div className="bg-black border border-[var(--industrial-border)] rounded-none p-12 w-full max-w-lg shadow-2xl animate-in zoom-in-95 duration-300">
            <div className="flex items-center space-x-4 mb-8">
              <div className="p-3 bg-[var(--industrial-accent)]/20 text-[var(--industrial-accent)] rounded-none">
                <FileJson size={24} />
              </div>
              <div>
                <h3 className="text-xl font-bold text-white tracking-tight leading-none mb-1 uppercase">Commit to Hub</h3>
                <p className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Scientific File System</p>
              </div>
            </div>
            
            <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 px-1">Resource Identity</label>
                <input 
                  autoFocus
                  type="text"
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && confirmSave()}
                  className="w-full bg-black border border-[var(--industrial-border)] rounded-none px-6 py-4 text-sm text-[var(--industrial-accent)] focus:outline-none focus:border-[var(--industrial-accent)]/50 transition-all font-mono"
                  placeholder="filename.json"
                />
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 px-1">Destination Folder</label>
                <div className="relative group">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500">
                    <Folder size={16} />
                  </div>
                  <select 
                    value={targetFolderPath}
                    onChange={(e) => setTargetFolderPath(e.target.value)}
                    className="w-full bg-black border border-[var(--industrial-border)] rounded-none pl-12 pr-6 py-4 text-sm text-[var(--industrial-accent)] focus:outline-none focus:border-[var(--industrial-accent)]/50 transition-all appearance-none"
                  >
                    {availableFolders.map(folder => (
                      <option key={folder.path} value={folder.path}>{folder.path}</option>
                    ))}
                  </select>
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-slate-500">
                    <ChevronRight size={16} className="rotate-90" />
                  </div>
                </div>
              </div>
              
              <div className="flex space-x-4 pt-2">
                <button 
                  onClick={() => setIsSaveModalOpen(false)} 
                  className="flex-1 px-6 py-4 rounded-none text-xs font-bold text-slate-400 hover:bg-white/5 transition-all uppercase tracking-widest border border-[var(--industrial-border)]"
                >
                  Abort
                </button>
                <button 
                  onClick={confirmSave} 
                  disabled={saveStatus === 'saving' || !newFileName.trim()}
                  className="flex-1 bg-[var(--industrial-accent)] hover:bg-[var(--industrial-accent-muted)] text-white rounded-none py-4 text-xs font-bold shadow-xl shadow-orange-900/20 transition-all flex items-center justify-center space-x-2 uppercase tracking-widest"
                >
                  {saveStatus === 'saving' ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                  <span>{saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Committed!' : 'Confirm'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={(e) => { if (e.target.files) Array.from(e.target.files).forEach(addAttachment); }} 
        multiple 
        className="hidden" 
      />
    </div>
  );
};

export default StructuringStudio;
