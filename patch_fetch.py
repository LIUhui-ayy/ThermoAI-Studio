import re

with open('components/AdvancedOptimization.tsx', 'r') as f:
    content = f.read()

target = """      const res = await fetch('/commit-adv-opt', {"""
replacement = """      const res = await fetch('http://127.0.0.1:8081/commit-adv-opt', {"""
content = content.replace(target, replacement)

target2 = """      await fetch('/run-adv-opt', {"""
replacement2 = """      await fetch('http://127.0.0.1:8081/run-adv-opt', {"""
content = content.replace(target2, replacement2)

target3 = """      await fetch('/stop-adv-opt', { method: 'POST' });"""
replacement3 = """      await fetch('http://127.0.0.1:8081/stop-adv-opt', { method: 'POST' });"""
content = content.replace(target3, replacement3)

target4 = """      const res = await fetch('/stream-adv-opt');"""
replacement4 = """      const res = await fetch('http://127.0.0.1:8081/stream-adv-opt');"""
content = content.replace(target4, replacement4)

target5 = """      const res = await fetch('/extract-best-adv-opt', {"""
replacement5 = """      const res = await fetch('http://127.0.0.1:8081/extract-best-adv-opt', {"""
content = content.replace(target5, replacement5)

target6 = """      const response = await fetch('/plot-property', {"""
replacement6 = """      const response = await fetch('http://127.0.0.1:8081/plot-property', {"""
content = content.replace(target6, replacement6)

with open('components/AdvancedOptimization.tsx', 'w') as f:
    f.write(content)
