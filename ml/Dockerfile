# Tesseract is a system package, so the service ships as an image rather than
# asking every developer to install OCR by hand.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY pyproject.toml ./
RUN pip install --no-cache-dir \
      "fastapi>=0.115" "uvicorn[standard]>=0.32" "python-multipart>=0.0.20" \
      "pydantic>=2.9" "pillow>=11.0" "numpy>=2.0" "pytesseract>=0.3.13" "pymupdf>=1.24"

COPY app ./app

# No scan is ever written to disk here: bytes arrive in the request, are rendered
# in memory, and go out as tokens. The service holds no state and no database.
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
