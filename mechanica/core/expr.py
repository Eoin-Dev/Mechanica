"""Safe mathematical expression compiler for user-defined force fields.

Compiles a restricted subset of Python expressions (arithmetic, comparisons,
ternaries and whitelisted math functions) into a fast callable. Anything
outside the whitelist -- attribute access, subscripts, lambdas, imports --
is rejected at compile time, so user input can never execute arbitrary code.

The whitelisted functions are numpy ufuncs, so a compiled expression works
both per-body (scalar env) and vectorized over every body at once (array
env) -- the engine uses the array form for large scenes.

Allowed variables: x, y (position, m), vx, vy (velocity, m/s),
t (time, s), m (mass, kg), r (distance from origin, m).
"""
from __future__ import annotations

import ast
import math
from typing import Callable

import numpy as np


def _reduce(ufunc, *args):
    """Fold a binary ufunc over 2+ arguments (min/max take any arity)."""
    out = args[0]
    for a in args[1:]:
        out = ufunc(out, a)
    return out


ALLOWED_NAMES = {"x", "y", "vx", "vy", "t", "m", "r"}
ALLOWED_FUNCS: dict[str, Callable] = {
    "sin": np.sin, "cos": np.cos, "tan": np.tan,
    "asin": np.arcsin, "acos": np.arccos, "atan": np.arctan,
    "atan2": np.arctan2, "sqrt": np.sqrt, "exp": np.exp,
    "log": np.log, "abs": np.abs,
    "min": lambda *a: _reduce(np.minimum, *a),
    "max": lambda *a: _reduce(np.maximum, *a),
    "sign": np.sign, "floor": np.floor,
    "ceil": np.ceil, "hypot": np.hypot,
}
ALLOWED_CONSTS = {"pi": math.pi, "e": math.e, "tau": math.tau, "g": 9.81}

_ALLOWED_NODES = (
    ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant, ast.Name, ast.Call,
    ast.Load, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Mod, ast.Pow,
    ast.FloorDiv, ast.USub, ast.UAdd, ast.IfExp, ast.Compare, ast.BoolOp,
    ast.And, ast.Or, ast.Not, ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.Eq,
    ast.NotEq,
)


class ExprError(ValueError):
    """Raised when an expression fails validation or compilation."""


def compile_expr(source: str) -> Callable[[dict], float]:
    """Compile `source` into a function of an environment dict.

    Raises ExprError with a human-readable message on invalid input.
    """
    source = source.strip()
    if not source:
        raise ExprError("empty expression")
    try:
        tree = ast.parse(source, mode="eval")
    except SyntaxError as exc:
        raise ExprError(f"syntax error: {exc.msg}") from exc

    for node in ast.walk(tree):
        if not isinstance(node, _ALLOWED_NODES):
            raise ExprError(f"'{type(node).__name__}' is not allowed")
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in ALLOWED_FUNCS:
                raise ExprError("only math functions like sin, cos, sqrt may be called")
            if node.keywords:
                raise ExprError("keyword arguments are not allowed")
        if isinstance(node, ast.Name):
            name = node.id
            if name not in ALLOWED_NAMES and name not in ALLOWED_FUNCS and name not in ALLOWED_CONSTS:
                raise ExprError(f"unknown name '{name}' (use x, y, vx, vy, t, m, r)")
        if isinstance(node, ast.Constant):
            if not isinstance(node.value, (int, float)):
                raise ExprError("only numeric constants are allowed")
            # ints become floats so e.g. 9**9**9 overflows immediately
            # instead of grinding out an astronomically large integer
            node.value = float(node.value)

    code = compile(tree, "<force-field>", "eval")
    static_env = {"__builtins__": {}}
    static_env.update(ALLOWED_FUNCS)
    static_env.update(ALLOWED_CONSTS)

    def fn(env: dict) -> float:
        with np.errstate(all="ignore"):
            return eval(code, static_env, env)  # noqa: S307 - AST whitelisted above

    # Probe once so obviously broken expressions fail at compile time.
    probe = {"x": 0.1, "y": 0.1, "vx": 0.0, "vy": 0.0, "t": 0.0, "m": 1.0, "r": 0.14}
    try:
        val = float(fn(probe))
        if math.isnan(val):
            # numpy signals domain errors (sqrt of a negative, log of zero)
            # with NaN instead of raising; reject those like math would
            raise ExprError("expression is undefined (NaN) at the test point")
    except ZeroDivisionError:
        pass  # may only divide by zero at specific points; allow
    except ExprError:
        raise
    except Exception as exc:
        raise ExprError(str(exc)) from exc
    return fn
