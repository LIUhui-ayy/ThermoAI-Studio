import re

with open('engine_advanced_opt.py', 'r') as f:
    content = f.read()

target = """@router.get("/stream-adv-opt")
async def stream_adv_opt():"""
replacement = """@router.get("/stream-adv-opt")
async def stream_adv_opt(db_name: str = None):"""
content = content.replace(target, replacement)

target2 = """    db_prefix = current_db_name.replace('.db', '').replace('_Final_Optimized', '').replace('_Optimized', '') if current_db_name else "A25-CU-MG\""""
replacement2 = """    effective_db = db_name if db_name else current_db_name
    db_prefix = effective_db.replace('.db', '').replace('_Final_Optimized', '').replace('_Optimized', '') if effective_db else "A25-CU-MG\""""
content = content.replace(target2, replacement2)

target3 = """    if current_db_name and os.path.exists(current_db_name):"""
replacement3 = """    if effective_db and os.path.exists(effective_db):"""
content = content.replace(target3, replacement3)

target4 = """            conn = sqlite3.connect(current_db_name, timeout=5.0)"""
replacement4 = """            conn = sqlite3.connect(effective_db, timeout=5.0)"""
content = content.replace(target4, replacement4)

with open('engine_advanced_opt.py', 'w') as f:
    f.write(content)
