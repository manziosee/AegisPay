from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="AegisPay Fraud Intelligence", version="0.1.0", docs_url="/docs")

class AnalyzeRequest(BaseModel):
    transaction_reference: str = Field(min_length=1, max_length=128)
    amount: int = Field(gt=0)
    currency: str = Field(min_length=3, max_length=3)

@app.get("/health/live")
def live():
    return {"status": "ok"}

@app.post("/v1/analyze")
def analyze(req: AnalyzeRequest):
    score = 60 if req.amount >= 10_000_000 else 0
    return {
        "transaction_reference": req.transaction_reference,
        "risk_score": score,
        "risk_level": "high" if score >= 50 else "low",
        "decision": "review" if score >= 50 else "allow",
        "model_version": "baseline-rules-v1",
        "mode": "sandbox",
    }
