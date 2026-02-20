packer {
  required_plugins {
    hcloud = {
      source  = "github.com/hetznercloud/hcloud"
      version = ">= 1.7.1"
    }
  }
}

variable "hcloud_token" {
  type      = string
  sensitive = true
  default   = env("HCLOUD_TOKEN")
}

variable "location" {
  type    = string
  default = "nbg1"
}

variable "server_type" {
  type    = string
  default = "cx23"
}

variable "image_version" {
  type    = string
  default = "18"
}

source "hcloud" "agentbox" {
  token       = var.hcloud_token
  image       = "ubuntu-24.04"
  location    = var.location
  server_type = var.server_type

  # Upgrade CPU for faster builds without changing disk size.
  # Snapshot inherits the 40GB disk from cx23, compatible with runtime instances.
  upgrade_server_type = "cpx42"

  server_name   = "agentbox-packer-build"
  snapshot_name = "agentbox-golden-v${var.image_version}"
  snapshot_labels = {
    app     = "agentbox"
    version = var.image_version
    os      = "ubuntu-24.04"
    base    = var.server_type
  }

  ssh_username            = "root"
  ssh_timeout             = "5m"
  temporary_key_pair_type = "ed25519"
}

build {
  sources = ["source.hcloud.agentbox"]

  # Upload the boot-time init script that persists in the golden image.
  # It runs on every new instance via cloud-init to generate a fresh wallet,
  # start the gateway, and callback to the API.
  provisioner "file" {
    source      = "agentbox-init.sh"
    destination = "/tmp/agentbox-init.sh"
  }

  # Build-time setup: installs Node.js, preloads/builds OpenClaw source,
  # prepares wallet helper deps, and configures base services/firewall.
  # Packer uploads, executes, and cleans up this script automatically.
  provisioner "shell" {
    script  = "setup.sh"
    timeout = "45m"
  }
}
