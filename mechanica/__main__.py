"""Entry point: run with  `python -m mechanica`  from the project root."""
import os
import sys

# allow running both as a package (python -m mechanica) and from the folder
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mechanica.app import main  # noqa: E402

if __name__ == "__main__":
    main()
