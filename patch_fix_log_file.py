import re

with open('engine_advanced_opt.py', 'r') as f:
    content = f.read()

target = """prefix = DB_FILE.replace('.db', '').replace('_Final_Optimized', '').replace('_Optimized', '')
LOG_FILE = f"{prefix}_Optimization_Final.log"

def setup_logging():"""

replacement = """
def setup_logging(prefix):
    LOG_FILE = f"{prefix}_Optimization_Final.log"
    for handler in logging.root.handlers[:]:
        logging.root.removeHandler(handler)
    file_handler = logging.FileHandler(LOG_FILE, mode='a', encoding='utf-8')
    file_format = logging.Formatter("%(asctime)s [%(process)d] %(message)s")
    file_handler.setFormatter(file_format)
    logger = logging.getLogger("Optimizer")
    logger.setLevel(logging.INFO)
    logger.addHandler(file_handler)
    optuna.logging.set_verbosity(optuna.logging.ERROR)
    return logger"""

# Now replace where setup_logging() is called
target_call = """logger = setup_logging()"""
replacement_call = """DB_FILE = "{req.out_db_name}"
    prefix = DB_FILE.replace('.db', '').replace('_Final_Optimized', '').replace('_Optimized', '')
    logger = setup_logging(prefix)"""

# In target we also need to remove the lines 117-124
import re
content = re.sub(r"prefix = DB_FILE\.replace\('.db', ''\)\.replace\('_Final_Optimized', ''\)\.replace\('_Optimized', ''\)\s*LOG_FILE = f\"\{prefix\}_Optimization_Final\.log\"\s*def setup_logging\(\):",
                 """def setup_logging(prefix):
    LOG_FILE = f"{prefix}_Optimization_Final.log\"""", content)

content = content.replace("logger = setup_logging()", replacement_call)

# wait, the DB_FILE is already defined later:
content = content.replace('DB_FILE = "{req.out_db_name}"\n    DB_URL', 'DB_URL')

with open('engine_advanced_opt.py', 'w') as f:
    f.write(content)
