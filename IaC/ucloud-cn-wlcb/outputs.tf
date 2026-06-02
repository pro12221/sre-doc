output "instance_ids" {
  value = ucloud_instance.new[*].id
}

output "instance_public_ips" {
  value = ucloud_eip.new[*].public_ip
}

output "instance_private_ips" {
  value = ucloud_instance.new[*].private_ip
}
