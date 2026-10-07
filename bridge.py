
import uvicorn, traceback, sys
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import engine_wizard
import engine_monitor
import engine_analysis
import engine_uncertainty
import engine_advanced_opt

app = FastAPI(title="ThermoAI Studio Modular Bridge V14.5")

# CORS configuration (keep unchanged)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount sub-router modules
app.include_router(engine_wizard.router)
app.include_router(engine_monitor.router)
app.include_router(engine_analysis.router)
app.include_router(engine_uncertainty.router)
app.include_router(engine_advanced_opt.router)

if __name__ == "__main__":
    try:
        print("🚀 ThermoAI Backend Service Starting...")
        print("🔗 Entry: http://127.0.0.1:8081")
        uvicorn.run(app, host="0.0.0.0", port=8081)
    except Exception as e:
        print(f"FATAL ERROR during startup: {e}")
        traceback.print_exc()
        sys.exit(1)
