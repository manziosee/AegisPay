FROM golang:1.27.3-alpine AS build
WORKDIR /src
RUN apk add --no-cache ca-certificates
COPY go.mod ./
RUN go mod download
COPY . .
# Populate checksums for imported packages before compiling. This also handles
# fresh checkouts where a go.sum has not been generated yet.
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/aegispay-api ./cmd/api

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/aegispay-api /aegispay-api
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/aegispay-api"]
