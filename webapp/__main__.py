"""Allow `python -m webapp` as well as `python -m webapp.server`."""
from .server import main

if __name__ == "__main__":
    main()
