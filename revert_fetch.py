import re

with open('components/AdvancedOptimization.tsx', 'r') as f:
    content = f.read()

target = """http://127.0.0.1:8081/"""
replacement = """/"""
content = content.replace(target, replacement)

with open('components/AdvancedOptimization.tsx', 'w') as f:
    f.write(content)
