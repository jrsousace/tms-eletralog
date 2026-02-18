# 🚚 EletraLog TMS - Gestão Logística

**EletraLog TMS** é um protótipo de Sistema de Gerenciamento de Transporte (TMS) corporativo desenvolvido em nuvem. O objetivo principal desta ferramenta é digitalizar, organizar e auditar o fluxo logístico de pátio, começando pelo módulo de **Agendamento Inbound** (Recebimento).

O sistema é multiusuário, responsivo e sincronizado em tempo real, garantindo que a equipe de logística, portaria e parceiros tenham uma visão única e atualizada da operação.

---

## 🚀 Funcionalidades Implementadas (MVP - V1)

### 1. Agendamento Inbound (Check-in de Doca e Portaria)
* **Grade de Horários 24h:** Visualização e reserva de slots de 10 em 10 minutos, cobrindo o dia inteiro (00:00 às 23:50).
* **Prevenção de Conflitos:** O sistema valida em tempo real na nuvem se o horário já foi ocupado por outro usuário, impedindo dupla marcação.
* **Detalhes da Carga:** Captura de dados cruciais como Pedido de Compra (PO), NF, Fornecedor, Solicitante, Comprador e CTRC.
* **Classificação de Frota:** Segmentação obrigatória por tipo de veículo (Moto, Passeio, Utilitário, VUC, 3/4, Toco, Truck, Carreta, Container).
* **Observações:** Campo de texto livre para direcionamentos operacionais (ex: "Descarga lateral").

### 2. Controle de Acesso (RBAC) e Usuários
O sistema conta com uma matriz de permissões rígida baseada em papéis (Roles):
* **MASTER (Diretoria):** Acesso total, pode criar/excluir qualquer usuário e cancelar qualquer agendamento.
* **GESTOR (Gestor Logística):** Pode gerenciar usuários e cancelar agendamentos.
* **USER (Analista/Operador):** Pode criar agendamentos e cancelar apenas os seus próprios.
* **TERCEIRO (Transportadora/Portaria):** Acesso **Somente Leitura**. Pode visualizar a grade, mas os campos de edição são bloqueados.
* *Nota: O campo CPF é opcional no cadastro, visando agilidade interna.*

### 3. Log e Auditoria
* **Histórico em Tempo Real:** Todo agendamento e cancelamento gera um log automático com carimbo de data/hora (Timestamp) e o nome do usuário que executou a ação.

### 4. Relatórios e Impressão
* Geração de espelho diário de agendamentos formatado para impressão, separando automaticamente os veículos alocados na **Doca** e na **Portaria**.

---

## 🛠️ Tecnologias Utilizadas

* **Frontend:** HTML5, CSS3 (Custom Properties, Flexbox/Grid) e JavaScript (ES6+, Async/Await).
* **Backend / Database:** [Google Firebase Firestore](https://firebase.google.com/) (Banco de dados NoSQL em tempo real).
* **Autenticação / Sessão:** Gerenciamento híbrido via Firestore e LocalStorage.
* **Hospedagem:** GitHub Pages (Servidor estático via CDN).
* **Ícones:** FontAwesome.

---

## 💻 Como Acessar e Testar

O projeto está hospedado e funcional.
Para utilização é necessário contato com desenvolvedor.
> **Nota:** Por ser uma aplicação web progressiva (PWA Ready), o site pode ser "Instalado" como um aplicativo no celular acessando as opções do navegador (Chrome/Safari) e selecionando "Adicionar à Tela Inicial".

## 🚧 Próximos Passos (Roadmap)

Os seguintes módulos já constam na interface gráfica e estão mapeados para as próximas Sprints (V2):

- [ ] **Módulo Outbound:** Agendamento e expedição de cargas.
- [ ] **Módulo de Transferência:** Gestão de movimentação entre CDs.
- [ ] **Registros de Insucessos:** Mapeamento de no-shows e devoluções.
- [ ] **Dashboards (Relatórios):** Gráficos de Performance (OTIF), Custo por Tonelada e Ocupação de Frota.
- [ ] **Segurança Avançada:** Implementação de Firebase Security Rules rígidas baseadas em UID.

---
*Desenvolvido internamente para otimização de processos logísticos corporativos.*
