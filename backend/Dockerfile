FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DB_URL=sqlite+aiosqlite:////data/flightlog.db
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY app ./app
# run as an unprivileged user; /data holds the SQLite database
RUN useradd --system --uid 10001 flightlog && mkdir /data && chown flightlog /data
USER flightlog
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
    CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/openapi.json', timeout=2)" || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
