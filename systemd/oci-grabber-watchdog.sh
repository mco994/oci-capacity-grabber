#!/bin/bash
[ -f /home/ubuntu/grabber/.won ] && exit 0
systemctl is-active --quiet oci-grabber.service && exit 0
logger -t oci-watchdog "grabber inactif et A1 non obtenue -> relance"
systemctl start oci-grabber.service
