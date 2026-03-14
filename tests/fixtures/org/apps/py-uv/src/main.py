from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.security import HTTPBearer
from pydantic import BaseModel

app = FastAPI(title="py-uv", version="0.2.0")
security = HTTPBearer()


class UserCreate(BaseModel):
    name: str
    email: str


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.get("/users/{user_id}")
def get_user(user_id: int, token=Depends(security)):
    if user_id <= 0:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )
    return {"id": user_id, "name": "Alice"}


@app.post("/users/", status_code=status.HTTP_201_CREATED)
def create_user(user: UserCreate):
    return {"id": 1, **user.model_dump()}
