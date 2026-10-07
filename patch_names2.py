import re

with open('engine_advanced_opt.py', 'r') as f:
    content = f.read()

target1 = """        for f in ["A25-CU-MG_Optimization_Final.log", "ZPF_Score_Summary.log", "ZPF_Phase_Details.log", "opt_script.log"]:
            if os.path.exists(f): os.remove(f)"""
            
replacement1 = """        prefix = req.out_db_name.replace('.db', '').replace('_Final_Optimized', '').replace('_Optimized', '')
        for f in [f"{prefix}_Optimization_Final.log", f"{prefix}_ZPF_Score_Summary.log", f"{prefix}_ZPF_Phase_Details.log", "opt_script.log"]:
            if os.path.exists(f): os.remove(f)"""
            
content = content.replace(target1, replacement1)

target2 = """LOG_FILE = "A25-CU-MG_Optimization_Final.log\""""
replacement2 = """prefix = DB_FILE.replace('.db', '').replace('_Final_Optimized', '').replace('_Optimized', '')
LOG_FILE = f"{prefix}_Optimization_Final.log\""""
content = content.replace(target2, replacement2)

target3 = """with open("ZPF_Score_Summary.log", "a", encoding="utf-8") as f:"""
replacement3 = """with open(f"{prefix}_ZPF_Score_Summary.log", "a", encoding="utf-8") as f:"""
content = content.replace(target3, replacement3)

target4 = """with open("ZPF_Phase_Details.log", "a", encoding="utf-8") as f:"""
replacement4 = """with open(f"{prefix}_ZPF_Phase_Details.log", "a", encoding="utf-8") as f:"""
content = content.replace(target4, replacement4)

with open('engine_advanced_opt.py', 'w') as f:
    f.write(content)
