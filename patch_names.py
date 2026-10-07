import re

with open('engine_advanced_opt.py', 'r') as f:
    content = f.read()

# Replace hardcoded text files in commit_adv_opt
target_commit = """    # Text files
    text_files = [req.tdb_name, "A25-CU-MG_Optimization_Final.log", "ZPF_Score_Summary.log", "opt_script.log"]"""

replacement_commit = """    # Get prefix from db_name
    prefix = req.db_name.replace('.db', '').replace('_Final_Optimized', '').replace('_Optimized', '')
    if not prefix: prefix = "Opt"
    
    # Text files
    text_files = [
        req.tdb_name, 
        f"{prefix}_Optimization_Final.log", 
        f"{prefix}_ZPF_Score_Summary.log", 
        f"{prefix}_ZPF_Phase_Details.log",
        "opt_script.log"
    ]"""

content = content.replace(target_commit, replacement_commit)

# Replace streaming logs hardcoded name
target_stream = """    logs = read_tail("A25-CU-MG_Optimization_Final.log", 100)"""
replacement_stream = """    prefix = current_db_name.replace('.db', '').replace('_Final_Optimized', '').replace('_Optimized', '') if current_db_name else "A25-CU-MG"
    logs = read_tail(f"{prefix}_Optimization_Final.log", 100)"""

content = content.replace(target_stream, replacement_stream)

target_detail = """    if not detail_logs:
        detail_logs = read_tail("ZPF_Score_Summary.log", 100)"""
replacement_detail = """    if not detail_logs:
        prefix = current_db_name.replace('.db', '').replace('_Final_Optimized', '').replace('_Optimized', '') if current_db_name else "A25-CU-MG"
        detail_logs = read_tail(f"{prefix}_ZPF_Score_Summary.log", 100)"""
        
content = content.replace(target_detail, replacement_detail)

with open('engine_advanced_opt.py', 'w') as f:
    f.write(content)
