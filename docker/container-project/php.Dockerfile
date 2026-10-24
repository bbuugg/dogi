# syntax=docker/dockerfile:1
# =============================================================================
# 容器型项目 · PHP 运行环境镜像。
#
#   docker build -t fizz/agent-php:latest -f docker/container-project/php.Dockerfile .
#
# 在基础镜像（Node + 我们的 agent 运行时）之上补 PHP CLI 与常用扩展 + composer。
# ⚠️ 需要基础镜像 `fizz/agent-runtime:latest` 已存在（宿主侧会先确保）。
#
# ## 为什么走 sury.org 而不是 Debian 自带的 `php-cli`
#
# 基础镜像是 Debian slim，`apt install php-cli` 装到的是**发行版冻结的那一版**（bookworm
# 是 8.2、trixie 是 8.4），比当前稳定版落后一大截。用户要「最新的」，所以从 Debian 官方的
# PHP 第三方源 `packages.sury.org/php` 装 **PHP 8.5**（当前最新稳定版）。
# codename 从 `/etc/os-release` 现取，基础镜像将来换 Debian 版本这里不用跟着改。
# =============================================================================

FROM fizz/agent-runtime:latest

# PHP 8.5 + 常用扩展 + composer
RUN set -eux; \
    . /etc/os-release; \
    curl -sSLo /usr/share/keyrings/deb.sury.org-php.gpg https://packages.sury.org/php/apt.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/deb.sury.org-php.gpg] https://packages.sury.org/php/ ${VERSION_CODENAME} main" > /etc/apt/sources.list.d/php.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      php8.5-cli \
      php8.5-mbstring \
      php8.5-xml \
      php8.5-curl \
      php8.5-zip \
      php8.5-intl \
      php8.5-mysql \
      php8.5-sqlite3 \
      unzip; \
    rm -rf /var/lib/apt/lists/*; \
    ln -sf /usr/bin/php8.5 /usr/local/bin/php; \
    curl -sS https://getcomposer.org/installer -o /tmp/composer-setup.php; \
    php /tmp/composer-setup.php --install-dir=/usr/local/bin --filename=composer; \
    rm -f /tmp/composer-setup.php

ENV FIZZ_CONTAINER_ENV=php
