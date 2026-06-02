terraform {
  required_providers {
    ucloud = {
      source  = "ucloud/ucloud"
      version = "~> 1.39.0"
    }
  }
}

provider "ucloud" {
  public_key  = var.ucloud_public_key
  private_key = var.ucloud_private_key
  project_id  = var.ucloud_project_id
  region      = "cn-wlcb"
}

# Data source: find Ubuntu 24.04 base image
data "ucloud_images" "ubuntu" {
  availability_zone = "cn-wlcb-01"
  name_regex        = "^Ubuntu 24.04"
  image_type        = "base"
}

# Create 3 UHost instances with 200GB data disks inline
resource "ucloud_instance" "new" {
  count             = 3
  availability_zone = "cn-wlcb-01"
  image_id          = data.ucloud_images.ubuntu.images[0].id
  instance_type     = "o-basic-4"
  name              = "tf-instance-${count.index + 1}"
  tag               = "tf-managed"
  boot_disk_type    = "cloud_rssd"
  boot_disk_size    = 20
  vpc_id            = "uvnet-l1iy0umj"
  subnet_id         = "subnet-32bsfnag"
  charge_type       = "dynamic"

  # 200GB RSSD data disk - created with the instance
  data_disks {
    size = 200
    type = "cloud_rssd"
  }
  delete_disks_with_instance = true

  # SSH key login
  login_mode  = "KeyPair"
  key_pair_id = "6264dd"
}

# Create 3 EIPs
resource "ucloud_eip" "new" {
  count         = 3
  name          = "tf-eip-${count.index + 1}"
  tag           = "tf-managed"
  bandwidth     = 1
  charge_mode   = "bandwidth"
  internet_type = "bgp"
  charge_type   = "dynamic"
}

# Bind EIP to instances
resource "ucloud_eip_association" "new" {
  count       = 3
  eip_id      = ucloud_eip.new[count.index].id
  resource_id = ucloud_instance.new[count.index].id
}
