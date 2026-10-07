import re

with open('engine_advanced_opt.py', 'r') as f:
    content = f.read()

target = """    # Remove old logs only if we are starting a fresh DB
    if not os.path.exists(req.out_db_name):
        for f in ["A25-CU-MG_Optimization_Final.log", "ZPF_Score_Summary.log", "ZPF_Phase_Details.log", "opt_script.log"]:
            if os.path.exists(f):
                os.remove(f)

    # We use a template for the python script, substituting values from req"""

replacement = """    prefix = req.out_db_name.replace('.db', '').replace('_Final_Optimized', '').replace('_Optimized', '')
    if not prefix: prefix = "Opt"

    # Remove old logs only if we are starting a fresh DB
    if not os.path.exists(req.out_db_name):
        for f in [f"{prefix}_Optimization_Final.log", f"{prefix}_ZPF_Score_Summary.log", f"{prefix}_ZPF_Phase_Details.log", "opt_script.log"]:
            if os.path.exists(f):
                os.remove(f)

    # We use a template for the python script, substituting values from req"""

content = content.replace(target, replacement)

# Wait! There's another `ZPF_Score_Summary.log` hardcoded inside stream_adv_opt
target_stream = """    detail_logs = read_tail("ZPF_Score_Summary.log", 100)"""
replacement_stream = """    detail_logs = read_tail(f"{prefix}_ZPF_Score_Summary.log", 100)"""
content = content.replace(target_stream, replacement_stream)

with open('engine_advanced_opt.py', 'w') as f:
    f.write(content)
