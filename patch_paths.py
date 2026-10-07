import re

with open('engine_advanced_opt.py', 'r') as f:
    content = f.read()

target = """    if req.initial_tdb_content:
        os.makedirs(os.path.dirname(req.initial_tdb) or '.', exist_ok=True)
        with open(req.initial_tdb, 'w', encoding='utf-8') as f:
            f.write(req.initial_tdb_content)"""

replacement = """    if req.initial_tdb_content:
        # Strip leading slash to write in local workspace instead of root
        local_initial_tdb = req.initial_tdb.lstrip('/')
        os.makedirs(os.path.dirname(local_initial_tdb) or '.', exist_ok=True)
        with open(local_initial_tdb, 'w', encoding='utf-8') as f:
            f.write(req.initial_tdb_content)"""

content = content.replace(target, replacement)

target2 = """    TDB_INPUT, DATA_INPUT = "{req.initial_tdb}", "{req.dataset_folder}" """
replacement2 = """    TDB_INPUT, DATA_INPUT = "{req.initial_tdb.lstrip('/')}", "{req.dataset_folder.lstrip('/')}" """
content = content.replace(target2, replacement2)

target3 = """    if req.dataset_files:
        os.makedirs(req.dataset_folder, exist_ok=True)
        for df in req.dataset_files:
            file_path = os.path.join(req.dataset_folder, df.name)
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(df.content)"""

replacement3 = """    if req.dataset_files:
        local_dataset_folder = req.dataset_folder.lstrip('/')
        os.makedirs(local_dataset_folder, exist_ok=True)
        for df in req.dataset_files:
            file_path = os.path.join(local_dataset_folder, df.name.lstrip('/'))
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(df.content)"""

content = content.replace(target3, replacement3)

with open('engine_advanced_opt.py', 'w') as f:
    f.write(content)
