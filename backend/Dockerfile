# ponytail: single stage. LibreOffice dwarfs everything, multi-stage saves little.
FROM node:22-slim

# libreoffice-convert shells out to soffice for doc conversion (see src/lib/convert.ts)
# The rest read scans and photographs (see src/lib/ocr.ts):
#   ocrmypdf/tesseract  add a text layer to a scanned page
#   unpaper             de-speckles and straightens photocopies (--clean/--deskew)
#   poppler-utils       pdftotext, used to tell a scan from a real text layer
#   img2pdf/imagemagick wrap a picture in a PDF
#   libheif-examples    heif-convert, for iPhone .heic photos
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libreoffice \
    ocrmypdf \
    tesseract-ocr \
    tesseract-ocr-eng \
    unpaper \
    poppler-utils \
    img2pdf \
    imagemagick \
    libheif-examples \
    fonts-liberation \
    fonts-crosextra-caladea \
    fonts-crosextra-carlito \
    fonts-ebgaramond \
  && rm -rf /var/lib/apt/lists/*

# Document previews are LibreOffice PDF conversions. A font the document asks
# for but the image does not have gets substituted, the different letter
# widths re-wrap every line, and justified paragraphs stretch to fill - the
# preview looks mangled next to the same file opened in Word. The packages
# above are metric-compatible stand-ins for the fonts legal documents use;
# this file points the ones fontconfig does not already cover at them.
COPY docker/fonts/99-legal-font-aliases.conf /etc/fonts/conf.d/
RUN fc-cache -f

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Meaning-based search reads a small embedding model locally. Bake it into the
# image so nothing is fetched from the network at run time (see
# src/lib/embeddings.ts). The build fails here if the model cannot be prepared.
ENV TRANSFORMERS_CACHE=/app/.models
RUN node scripts/warm-embeddings.mjs

ENV NODE_ENV=production
EXPOSE 3001
# Started directly rather than through npm: npm does not pass the stop signal
# on to node, so the server never heard it and an answer being written was cut
# off with nothing saved (see lib/chat/liveAnswers.ts).
CMD ["node", "dist/index.js"]
