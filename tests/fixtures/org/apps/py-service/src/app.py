"""Starlette microservice."""
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route


async def homepage(request):
    return JSONResponse({'status': 'ok'})


app = Starlette(routes=[Route('/', homepage)])
