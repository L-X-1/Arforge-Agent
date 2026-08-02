FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/nginx.conf
COPY site /usr/share/nginx/html
HEALTHCHECK --interval=5s --timeout=2s \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
EXPOSE 8080
