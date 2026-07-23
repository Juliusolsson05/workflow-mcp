variable "VERSION" {
  default = "0.0.0"
}

variable "REVISION" {
  default = "development"
}

variable "IMAGE" {
  default = "workflow-mcp:development"
}

group "default" {
  targets = ["workflow-mcp"]
}

target "workflow-mcp" {
  context = "../.."
  dockerfile = "standalone/docker/Dockerfile"
  platforms = ["linux/amd64", "linux/arm64"]
  tags = [IMAGE]
  args = {
    VERSION = VERSION
    REVISION = REVISION
  }
}
