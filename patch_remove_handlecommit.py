import re

with open('components/AdvancedOptimization.tsx', 'r') as f:
    content = f.read()

# remove from "const handleCommitResult =" to just before "// Logs & Observation State"
target = re.compile(r"  const handleCommitResult = async \(targetFolder: string\) => \{.*?\};\n\n  // Logs & Observation State", re.DOTALL)

content = target.sub("  // Logs & Observation State", content)

with open('components/AdvancedOptimization.tsx', 'w') as f:
    f.write(content)
