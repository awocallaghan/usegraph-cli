from flask import Flask, request, jsonify
import pandas as pd

app = Flask(__name__)


@app.route("/")
def index():
    return "Hello from Flask!"


@app.route("/data")
def get_data():
    df = pd.DataFrame({"a": [1, 2, 3], "b": [4, 5, 6]})
    result = df.to_dict(orient="records")
    return jsonify(result)


@app.route("/filter")
def filter_data():
    value = request.args.get("value", 0)
    df = pd.DataFrame({"x": [1, 2, 3]})
    filtered = df[df["x"] > int(value)]
    return jsonify(filtered.to_dict(orient="records"))
