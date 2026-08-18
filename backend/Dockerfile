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
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3001
CMD ["npm", "start"]
