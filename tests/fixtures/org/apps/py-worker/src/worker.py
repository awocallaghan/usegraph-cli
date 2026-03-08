"""Celery worker entry point."""
from celery import Celery

app = Celery('worker', broker='redis://localhost:6379/0')

app.conf.update(
    task_serializer='json',
    accept_content=['json'],
    result_serializer='json',
    timezone='UTC',
    enable_utc=True,
)
