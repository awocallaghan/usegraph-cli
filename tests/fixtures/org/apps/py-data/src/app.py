from flask import Flask
import pandas as pd

app = Flask(__name__)


@app.route("/")
def index():
    return "Hello from Flask!"
