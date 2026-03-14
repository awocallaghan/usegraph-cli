#!/usr/bin/env python
"""Django project: models and management entry point."""
import os
import sys
from django.core.management import execute_from_command_line
from django.db import models
from django.contrib.auth.models import User


class Article(models.Model):
    title = models.CharField(max_length=200)
    content = models.TextField()
    author = models.ForeignKey(User, on_delete=models.CASCADE)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


def main():
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "myproject.settings")
    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
