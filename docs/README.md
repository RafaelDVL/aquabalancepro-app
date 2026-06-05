# AquaBalancePro - Integração de Documentação

Bem-vindo à documentação do projeto **AquaBalancePro**.

## Estrutura do Projeto

### 📱 Aplicativo (Ionic/Angular)

O aplicativo móvel para controle e monitoramento.

- **Localização**: `/src/app`
- **Tecnologias**: Ionic 8, Angular 20, Tailwind CSS.

### 🤖 Firmware (ESP32)

O código embarcado para o controlador de dosagem.

- **Localização**: `/esp32`
- **Framework**: PlatformIO / Arduino Framework.
- **Hardware**: ESP32-S3, RTC DS3231, 4 bombas peristálticas.

## Documentos Disponíveis

- [Arquitetura do Sistema](arquitetura.md) — Visão técnica geral
- [App Mobile (Ionic/Angular)](ionic-app.md) — Documentação completa do frontend
- [Firmware ESP32](esp32-firmware.md) — Documentação completa do firmware embarcado
- [Robustez Offline](../esp32/ROBUSTEZ_OFFLINE.md) — Estratégias de resiliência offline do ESP32
