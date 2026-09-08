# 受控执行环境镜像：无凭据、无网络运行时注入（spec 6.2；M0 本地模拟形态）
# 构建：docker build -t dataplat-script:m0 m0/sandbox/
FROM python:3.12-slim
# 金样管线零 pip 包（m0/env-manifest.md），故无 pip install 行；
# requirements.txt 仅作依赖清单存档进镜像，便于审计"镜像里有什么"
COPY requirements.txt /tmp/requirements.txt
# 注：基础镜像 Debian 已内置 nobody(UID 65534)，计划稿的 `useradd -u 65534 -m scriptuser`
# 会因 "UID 65534 is not unique" 构建失败 —— 直接复用该既有身份（实测 2026-09-08）
USER 65534
WORKDIR /workdir
