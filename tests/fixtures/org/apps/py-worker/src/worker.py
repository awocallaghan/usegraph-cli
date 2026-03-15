"""Celery worker entry point."""
import structlog
from celery import Celery
from celery.utils.log import get_task_logger
from kombu import Exchange, Queue

log = structlog.get_logger(__name__)
logger = get_task_logger(__name__)

app = Celery("worker", broker="redis://localhost:6379/0")

task_exchange = Exchange("tasks", type="direct")
default_queue = Queue("default", task_exchange, routing_key="default")

app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_queues=[default_queue],
)


@app.task(name="send_email")
def send_email(to: str, subject: str, body: str):
    log.info("Sending email", to=to, subject=subject)
    return {"status": "sent", "to": to}
