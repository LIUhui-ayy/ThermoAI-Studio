import re

with open('components/AdvancedOptimization.tsx', 'r') as f:
    content = f.read()

target = """        const res = await fetch('/stream-adv-opt');"""
replacement = """        const res = await fetch(`/stream-adv-opt?db_name=${encodeURIComponent(outDbName)}`);"""
content = content.replace(target, replacement)

with open('components/AdvancedOptimization.tsx', 'w') as f:
    f.write(content)
